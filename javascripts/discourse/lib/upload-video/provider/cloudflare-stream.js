import TusUploadClient from "../tus-client";
import { CancelledError, sleep, UploadVideoError } from "../util";

export default class CloudflareStreamUploadClient extends TusUploadClient {
  constructor(options = {}) {
    super(options);

    this.brokerOrigin = (options.brokerOrigin || "").replace(/\/$/, "");
    this.uid = null;
    this.iframeUrl = null;
    this.statusUrl = null;
    this.uploadType = null;
    this.simpleMode = false;
    this.simpleUploadUrl = null;
  }

  async createUploadSession() {
    const xhr = await this.xhr({
      method: "POST",
      url: `${this.brokerOrigin}/uploads/direct`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: this.file.name,
        mime_type: this.file.type,
        size: this.file.size,
        title: this.metadata.title,
      }),
    });

    const response = this.parseJson(
      xhr.responseText,
      "Invalid Cloudflare Stream session response.",
      "errors.cloudflare_session_response_invalid"
    );

    this.uploadType = response?.upload_type ?? null;
    this.uid = response?.uid ?? null;
    this.iframeUrl = response?.iframe_url ?? null;
    this.statusUrl = response?.status_url ?? null;

    if (!response?.upload_url) {
      throw new UploadVideoError(
        "errors.cloudflare_upload_url_missing",
        "Missing Cloudflare Stream upload URL in response."
      );
    }

    if (this.uploadType === "basic_post") {
      this.simpleMode = true;
      this.simpleUploadUrl = response.upload_url;
    } else {
      this.url = response.upload_url;
    }
  }

  async sendFile() {
    if (!this.simpleMode) {
      return await super.sendFile();
    }

    this.throwIfCancelled();

    const formData = new FormData();
    formData.append("file", this.file);

    try {
      const xhr = await this.xhr({
        method: "POST",
        url: this.simpleUploadUrl,
        body: formData,
        onUploadProgress: (e) => {
          if (typeof this.onProgress === "function") {
            this.onProgress({ loaded: e.loaded, total: this.file.size });
          }
        },
      });

      if (!this.isSuccessStatus(xhr.status)) {
        throw this.makeXHRError(
          xhr,
          "Cloudflare Stream upload failed.",
          "errors.cloudflare_upload_failed"
        );
      }
    } catch (error) {
      return await this.handleUploadError(error);
    }
  }

  async fetchStatus() {
    const xhr = await this.xhr({
      method: "GET",
      url: this.statusUrl,
      headers: { Authorization: `Bearer ${this.token}` },
    });

    return this.parseJson(
      xhr.responseText,
      "Invalid Cloudflare Stream status response.",
      "errors.cloudflare_status_response_invalid"
    );
  }

  async waitForReady({
    interval = 5000,
    timeout = 10 * 60 * 1000,
    onStatus = null,
    shouldCancel = null,
    onEmbeddable = null,
    shouldInsertEarly = null,
  } = {}) {
    const startedAt = Date.now();
    let announced = false;

    while (true) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }

      // The Cloudflare embed URL is known from the upload session, so it can be
      // inserted while the video is still transcoding.
      if (this.iframeUrl && !announced) {
        announced = true;
        if (typeof onEmbeddable === "function") {
          onEmbeddable(this.iframeUrl);
        }
      }

      if (
        this.iframeUrl &&
        typeof shouldInsertEarly === "function" &&
        shouldInsertEarly()
      ) {
        return { status: null, timedOut: false, iframeUrl: this.iframeUrl };
      }

      let record = null;
      try {
        record = await this.fetchStatus();
      } catch (error) {
        if (!this.isTransientStatus(error?.status)) {
          throw error;
        }
      }

      if (record) {
        if (typeof onStatus === "function") {
          onStatus(record.status);
        }

        if (record.ready) {
          this.iframeUrl = record.iframe_url ?? this.iframeUrl;
          return {
            status: record.status,
            timedOut: false,
            iframeUrl: this.iframeUrl,
          };
        }

        if (record.status === "error") {
          throw new UploadVideoError(
            "errors.cloudflare_processing_failed",
            "Cloudflare Stream could not process this video.",
            { cleanup: true }
          );
        }
      }

      if (Date.now() - startedAt > timeout) {
        return {
          status: record?.status,
          timedOut: true,
          iframeUrl: this.iframeUrl,
        };
      }

      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }

      await sleep(interval);
    }
  }

  getResult() {
    return this.iframeUrl;
  }

  // The broker exposes no delete endpoint yet; cleanup is a no-op so the modal's
  // cancel/cleanup arms work uniformly across providers.
  async deleteVideo() {}
}
