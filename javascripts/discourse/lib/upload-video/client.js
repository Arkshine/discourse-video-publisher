import { CancelledError, sleep, UploadVideoError } from "./util";

export default class ResumableUploadClient {
  static defaults = {
    contentType: "application/octet-stream",
    offset: 0,
    chunkSize: 64 * 1024 * 1024, // 64MB chunks
    initialRetryInterval: 1000,
    maxRetryInterval: 60000,
    maxRetryElapsedMillis: 10 * 60 * 1000,
    onProgress: () => {},
  };

  constructor(options = {}) {
    const merged = {
      ...ResumableUploadClient.defaults,
      ...options,
    };

    if (!(merged.file instanceof Blob)) {
      throw new UploadVideoError(
        "errors.invalid_file",
        "Missing or invalid file. Expected File or Blob."
      );
    }

    if (!merged.token) {
      throw new UploadVideoError(
        "errors.missing_token",
        "Missing bearer token."
      );
    }

    this.token = merged.token;
    this.file = merged.file;
    this.url = merged.url ?? null;
    this.baseUrl = merged.baseUrl ?? null;
    this.params = { ...(merged.params || {}) };
    this.metadata = merged.metadata || {};

    this.contentType = merged.contentType || merged.file.type;

    this.offset = merged.offset || 0;
    this.chunkSize = merged.chunkSize || 0;

    this.onProgress = merged.onProgress;

    this.initialRetryInterval = merged.initialRetryInterval;
    this.retryInterval = this.initialRetryInterval;
    this.maxRetryInterval = merged.maxRetryInterval;
    this.maxRetryElapsedMillis = merged.maxRetryElapsedMillis;
    this.retryStartedAt = null;

    this.isPaused = false;
    this.cancelRequested = false;
    this.activeXhr = null;
    this.resumeResolver = null;
  }

  async upload() {
    await this.createUploadSessionWithRetry();
    this.throwIfCancelled();
    await this.sendFile();

    return this.getResult?.() ?? null;
  }

  throwIfCancelled() {
    if (this.cancelRequested) {
      throw new CancelledError();
    }
  }

  async createUploadSessionWithRetry() {
    try {
      return await this.createUploadSession();
    } catch (error) {
      return await this.retryTransientError(error, () =>
        this.createUploadSessionWithRetry()
      );
    }
  }

  async sendFile() {
    this.throwIfCancelled();

    const { content, end } = this.getChunk();

    try {
      const xhr = await this.xhr({
        method: this.getUploadMethod(),
        url: this.url,
        headers: this.getUploadHeaders(end),
        body: content,
        onUploadProgress: (e) => {
          if (typeof this.onProgress === "function") {
            this.onProgress({
              loaded: this.offset + e.loaded,
              total: this.file.size,
            });
          }
        },
      });

      return await this.handleUploadSuccess(xhr, end);
    } catch (error) {
      return await this.handleUploadError(error);
    }
  }

  getChunk() {
    const end = this.chunkSize
      ? Math.min(this.offset + this.chunkSize, this.file.size)
      : this.file.size;

    const content =
      this.offset || this.chunkSize
        ? this.file.slice(this.offset, end)
        : this.file;

    return { content, end };
  }

  async handleUploadError(error) {
    return await this.retryTransientError(error, () => this.resume());
  }

  async retryTransientError(error, retryCallback) {
    if (error?.cancelled || this.cancelRequested) {
      throw new CancelledError();
    }

    if (this.isPaused) {
      this.resetRetry();

      await new Promise((resolve) => {
        this.resumeResolver = resolve;
      });

      this.throwIfCancelled();
      return await retryCallback();
    }

    const status = error?.status;

    if (status === 0 || status >= 500) {
      return await this.retry(retryCallback);
    }

    throw error;
  }

  async retry(fn) {
    this.retryStartedAt ??= Date.now();

    if (Date.now() - this.retryStartedAt > this.maxRetryElapsedMillis) {
      throw new UploadVideoError(
        "errors.upload_retry_timeout",
        "Upload retry timed out."
      );
    }

    await sleep(this.retryInterval);
    this.retryInterval = this.nextRetryInterval();
    return fn();
  }

  resetRetry() {
    this.retryInterval = this.initialRetryInterval;
    this.retryStartedAt = null;
  }

  nextRetryInterval() {
    const jitter = Math.floor(Math.random() * 1001);
    return Math.min(this.retryInterval * 2 + jitter, this.maxRetryInterval);
  }

  pause() {
    this.isPaused = true;
    this.activeXhr?.abort();
  }

  unpause() {
    this.isPaused = false;

    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
  }

  cancel() {
    this.cancelRequested = true;
    this.activeXhr?.abort();

    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
  }

  buildUrl(params = {}, baseUrl) {
    let url = baseUrl || this.getDefaultBaseUrl();

    const query = new URLSearchParams(params).toString();
    if (query) {
      url += `?${query}`;
    }

    return url;
  }

  parseJson(
    text,
    fallbackMessage = "Invalid JSON response.",
    translationKey = "errors.invalid_json_response"
  ) {
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new UploadVideoError(translationKey, fallbackMessage);
    }
  }

  makeXHRError(
    xhr,
    fallbackMessage,
    translationKey = "errors.upload_request_failed"
  ) {
    const error = xhr.responseText
      ? new Error(xhr.responseText)
      : new UploadVideoError(
          translationKey,
          fallbackMessage || `HTTP ${xhr.status}`
        );

    error.status = xhr.status;
    error.xhr = xhr;
    return error;
  }

  xhr({ method, url, headers = {}, body, onUploadProgress }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeXhr = xhr;

      xhr.open(method, url, true);

      Object.entries(headers).forEach(([key, value]) => {
        if (value != null) {
          xhr.setRequestHeader(key, value);
        }
      });

      if (xhr.upload && typeof onUploadProgress === "function") {
        xhr.upload.addEventListener("progress", onUploadProgress);
      }

      xhr.onload = () => {
        if (this.isSuccessStatus(xhr.status)) {
          resolve(xhr);
        } else {
          reject(this.makeXHRError(xhr, "Upload request failed."));
        }
      };

      xhr.onerror = () => {
        reject(
          this.makeXHRError(
            xhr,
            "Network error during upload request.",
            "errors.network_error"
          )
        );
      };

      xhr.onabort = () => {
        if (this.cancelRequested) {
          reject(new CancelledError());
        } else {
          reject(
            new UploadVideoError("status.paused", "Upload paused", {
              details: { isAbort: true },
            })
          );
        }
      };

      xhr.send(body);
    });
  }

  isSuccessStatus(status) {
    return status >= 200 && status < 300;
  }

  getUploadMethod() {
    return "PUT";
  }
}
