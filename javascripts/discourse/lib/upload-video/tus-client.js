import ResumableUploadClient from "./client";

export default class TusUploadClient extends ResumableUploadClient {
  static defaults = {
    contentType: "application/offset+octet-stream",
  };

  constructor(options = {}) {
    super({ ...TusUploadClient.defaults, ...options });
    this.accept = null;
  }

  getUploadMethod() {
    return "PATCH";
  }

  getUploadHeaders() {
    const headers = {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(this.offset),
      "Content-Type": this.contentType,
    };

    if (this.accept) {
      headers.Accept = this.accept;
    }

    return headers;
  }

  async resume() {
    try {
      const headers = { "Tus-Resumable": "1.0.0" };
      if (this.accept) {
        headers.Accept = this.accept;
      }

      const xhr = await this.xhr({ method: "HEAD", url: this.url, headers });

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
      "Upload failed.",
      "errors.upload_request_failed"
    );
  }
}
