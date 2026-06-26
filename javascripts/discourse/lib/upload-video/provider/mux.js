import ResumableUploadClient from "../client";
import { CancelledError, sleep, UploadVideoError } from "../util";

export default class MuxUploadClient extends ResumableUploadClient {
  constructor(options = {}) {
    super(options);

    this.brokerOrigin = (options.brokerOrigin || "").replace(/\/$/, "");
    this.uploadId = null;
    this.statusUrl = null;
    this.iframeUrl = null;
  }

  getUploadMethod() {
    return "PUT";
  }

  isSuccessStatus(status) {
    return (status >= 200 && status < 300) || status === 308;
  }

  getUploadHeaders(end) {
    return {
      "Content-Type": this.contentType,
      "Content-Range": `bytes ${this.offset}-${end - 1}/${this.file.size}`,
    };
  }

  async createUploadSession() {
    const xhr = await this.xhr({
      method: "POST",
      url: `${this.brokerOrigin}/mux/uploads`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: this.file.name,
        mime_type: this.file.type,
        size: this.file.size,
        title: this.metadata.title,
        topic_id: null,
      }),
    });

    const response = this.parseJson(
      xhr.responseText,
      "Invalid Mux session response.",
      "errors.mux_session_response_invalid"
    );

    this.uploadId = response?.upload_id ?? null;
    this.statusUrl = response?.status_url ?? null;

    if (!response?.upload_url) {
      throw new UploadVideoError(
        "errors.mux_upload_url_missing",
        "Missing Mux upload URL in response."
      );
    }

    this.url = response.upload_url;
  }

  async resume() {
    try {
      const xhr = await this.xhr({
        method: "PUT",
        url: this.url,
        headers: { "Content-Range": `bytes */${this.file.size}` },
      });

      return await this.handleUploadSuccess(xhr);
    } catch (error) {
      return await this.handleUploadError(error);
    }
  }

  async handleUploadSuccess(xhr) {
    if (xhr.status === 200 || xhr.status === 201) {
      this.resetRetry();
      return;
    }

    if (xhr.status === 308) {
      const rangeOffset = this.extractRangeOffset(xhr);
      if (rangeOffset != null) {
        this.offset = rangeOffset;
      }

      this.resetRetry();
      await this.sendFile();
      return;
    }

    throw this.makeXHRError(
      xhr,
      "Mux upload failed.",
      "errors.mux_upload_failed"
    );
  }

  extractRangeOffset(xhr) {
    const range = xhr.getResponseHeader("Range");
    if (!range) {
      return null;
    }

    const matches = range.match(/\d+/g);
    if (!matches?.length) {
      return null;
    }

    return parseInt(matches[matches.length - 1], 10) + 1;
  }

  async fetchStatus() {
    const xhr = await this.xhr({
      method: "GET",
      url: this.statusUrl,
      headers: { Authorization: `Bearer ${this.token}` },
    });

    return this.parseJson(
      xhr.responseText,
      "Invalid Mux status response.",
      "errors.mux_status_response_invalid"
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

      // The Mux player URL exists once the asset is created (well before
      // transcoding finishes), so it can be inserted early.
      if (
        this.iframeUrl &&
        typeof shouldInsertEarly === "function" &&
        shouldInsertEarly()
      ) {
        return {
          status: null,
          timedOut: false,
          iframeUrl: this.iframeUrl,
        };
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
          onStatus(record.asset_status);
        }

        if (record.iframe_url) {
          this.iframeUrl = record.iframe_url;
          if (!announced) {
            announced = true;
            if (typeof onEmbeddable === "function") {
              onEmbeddable(this.iframeUrl);
            }
          }
        }

        if (record.ready) {
          this.iframeUrl = record.iframe_url ?? this.iframeUrl;
          return {
            status: record.asset_status,
            timedOut: false,
            iframeUrl: this.iframeUrl,
          };
        }

        if (record.asset_status === "errored" || record.error) {
          throw new UploadVideoError(
            "errors.mux_processing_failed",
            "Mux could not process this video.",
            { cleanup: true }
          );
        }
      }

      if (Date.now() - startedAt > timeout) {
        return {
          status: record?.asset_status,
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

  // The broker exposes no delete endpoint yet; cleanup is a no-op.
  async deleteVideo() {}
}
