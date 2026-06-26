import TusUploadClient from "../tus-client";
import { CancelledError, sleep, UploadVideoError } from "../util";

export default class VimeoUploadClient extends TusUploadClient {
  static defaults = {
    apiUrl: "https://api.vimeo.com",
    apiVersion: "3.4",
    contentType: "application/offset+octet-stream",
  };

  constructor(options = {}) {
    const merged = { ...VimeoUploadClient.defaults, ...options };
    super(merged);

    this.apiUrl = merged.apiUrl;
    this.apiVersion = merged.apiVersion;
    this.accept = `application/vnd.vimeo.*+json;version=${this.apiVersion}`;

    this.httpMethod = "POST";
    this.videoUri = null;
    this.videoLink = null;

    if (!this.url) {
      this.url = this.buildUrl(this.params, this.baseUrl);
    }
  }

  getDefaultBaseUrl() {
    return `${this.apiUrl}/me/videos`;
  }

  async createUploadSession() {
    const body = {
      ...this.metadata,
      upload: {
        ...(this.metadata.upload || {}),
        approach: "tus",
        size: this.file.size,
      },
    };

    const xhr = await this.xhr({
      method: this.httpMethod,
      url: this.url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: this.accept,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const response = this.parseJson(
      xhr.responseText,
      "Invalid Vimeo session response.",
      "errors.vimeo_session_response_invalid"
    );
    this.url = response?.upload?.upload_link;
    this.videoUri = response?.uri ?? null;
    this.videoLink = response?.link ?? null;

    if (!this.url) {
      throw new UploadVideoError(
        "errors.vimeo_upload_link_missing",
        "Missing Vimeo upload_link in response."
      );
    }
  }

  async fetchStatus() {
    if (!this.videoUri) {
      throw new UploadVideoError(
        "errors.vimeo_video_uri_missing",
        "No video URI available. Upload must complete first."
      );
    }

    const xhr = await this.xhr({
      method: "GET",
      url: `${this.apiUrl}${this.videoUri}?fields=status,transcode.status`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: this.accept,
        "Content-Type": "application/json",
      },
    });

    const data = this.parseJson(
      xhr.responseText,
      "Invalid Vimeo transcode response.",
      "errors.vimeo_transcode_response_invalid"
    );
    return { status: data?.status, transcode: data?.transcode?.status };
  }

  async waitForTranscode({
    interval = 5000,
    timeout = 10 * 60 * 1000,
    onStatus = null,
    shouldCancel = null,
  } = {}) {
    // Watch the video `status` too: transcode can stay "in_progress" forever
    // when the upload itself failed.
    const QUOTA_STATUSES = ["quota_exceeded", "total_cap_exceeded"];
    const FATAL_STATUSES = [
      "uploading_error",
      "transcoding_error",
      ...QUOTA_STATUSES,
    ];

    const startedAt = Date.now();

    while (true) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }

      let status = null;
      let transcode = null;
      try {
        ({ status, transcode } = await this.fetchStatus());
      } catch (error) {
        if (!this.isTransientStatus(error?.status)) {
          throw error;
        }
      }

      if (typeof onStatus === "function") {
        onStatus(transcode);
      }

      if (status === "available" || transcode === "complete") {
        return { status: transcode, timedOut: false };
      }

      if (transcode === "error" || FATAL_STATUSES.includes(status)) {
        if (QUOTA_STATUSES.includes(status)) {
          throw new UploadVideoError(
            "errors.vimeo_quota_exceeded",
            "Vimeo account upload limit reached.",
            { cleanup: true }
          );
        }

        throw new UploadVideoError(
          "errors.vimeo_processing_failed",
          "Vimeo could not process this video.",
          { cleanup: true }
        );
      }

      if (Date.now() - startedAt > timeout) {
        // The upload already succeeded and the link is valid; Vimeo keeps
        // transcoding server-side. Stop watching and let the caller insert the
        // link rather than failing a large upload that just transcodes slowly.
        return { status: transcode, timedOut: true };
      }

      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }

      await sleep(interval);
    }
  }

  getResult() {
    return this.videoUri;
  }

  async deleteVideo({ maxAttempts = 4, maxWaitMs = 60_000 } = {}) {
    if (!this.videoUri) {
      return;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.xhr({
          method: "DELETE",
          url: `${this.apiUrl}${this.videoUri}`,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: this.accept,
          },
        });
        return;
      } catch (error) {
        if (error?.status !== 429 || attempt === maxAttempts) {
          throw error;
        }

        const headerWait = parseVimeoRateLimitWait(error.xhr);
        const backoff = Math.min(2 ** attempt * 1000, maxWaitMs);
        const wait = Math.min(headerWait ?? backoff, maxWaitMs);
        await sleep(wait);
      }
    }
  }
}

function parseVimeoRateLimitWait(xhr) {
  if (!xhr) {
    return null;
  }

  const retryAfter = xhr.getResponseHeader("Retry-After");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  const reset = xhr.getResponseHeader("X-RateLimit-Reset");
  if (reset) {
    const date = Date.parse(reset);

    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  return null;
}
