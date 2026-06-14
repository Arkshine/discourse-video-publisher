import ResumableUploadClient from "../client";
import { CancelledError, sleep, UploadVideoError } from "../util";

export default class VimeoUploadClient extends ResumableUploadClient {
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

  getUploadMethod() {
    return "PATCH";
  }

  getUploadHeaders() {
    return {
      Accept: this.accept,
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(this.offset),
      "Content-Type": this.contentType,
    };
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

  async resume() {
    try {
      const xhr = await this.xhr({
        method: "HEAD",
        url: this.url,
        headers: {
          Accept: this.accept,
          "Tus-Resumable": "1.0.0",
        },
      });

      const uploadOffset = xhr.getResponseHeader("Upload-Offset");
      if (uploadOffset != null) {
        this.offset = parseInt(uploadOffset, 10) || 0;
      }

      if (this.offset >= this.file.size) {
        return;
      }

      return await this.sendFile();
    } catch (error) {
      return await this.handleUploadError(error);
    }
  }

  async handleUploadSuccess(xhr) {
    if (xhr.status >= 200 && xhr.status < 300) {
      this.resetRetry();

      const uploadOffset = xhr.getResponseHeader("Upload-Offset");
      if (uploadOffset != null) {
        this.offset = parseInt(uploadOffset, 10) || 0;
      }

      if (this.offset < this.file.size) {
        return await this.sendFile();
      }

      return;
    }

    throw this.makeXHRError(
      xhr,
      "Vimeo upload failed.",
      "errors.vimeo_upload_failed"
    );
  }

  async transcodeStatus() {
    if (!this.videoUri) {
      throw new UploadVideoError(
        "errors.vimeo_video_uri_missing",
        "No video URI available. Upload must complete first."
      );
    }

    const xhr = await this.xhr({
      method: "GET",
      url: `${this.apiUrl}${this.videoUri}`,
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
    return data?.transcode?.status;
  }

  async waitForTranscode({
    interval = 5000,
    timeout = 10 * 60 * 1000,
    onStatus = null,
    shouldCancel = null,
  } = {}) {
    const startedAt = Date.now();

    while (true) {
      const status = await this.transcodeStatus();

      if (typeof onStatus === "function") {
        onStatus(status);
      }

      if (status === "complete") {
        return { status, timedOut: false };
      }

      if (status === "error") {
        throw new UploadVideoError(
          "errors.vimeo_transcoding_failed",
          "Vimeo transcoding failed."
        );
      }

      if (Date.now() - startedAt > timeout) {
        // The upload already succeeded and the link is valid; Vimeo keeps
        // transcoding server-side. Stop watching and let the caller insert the
        // link rather than failing a large upload that just transcodes slowly.
        return { status, timedOut: true };
      }

      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }

      await sleep(interval);

      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw new CancelledError();
      }
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
