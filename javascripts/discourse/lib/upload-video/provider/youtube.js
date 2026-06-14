import ResumableUploadClient from "../client";
import { CancelledError, sleep, UploadVideoError } from "../util";

export default class YouTubeUploadClient extends ResumableUploadClient {
  static defaults = {
    baseUrl: "https://www.googleapis.com/upload/youtube/v3/videos",
  };

  constructor(options = {}) {
    const merged = { ...YouTubeUploadClient.defaults, ...options };
    super(merged);

    this.httpMethod = "POST";

    if (!this.url) {
      this.params.uploadType = "resumable";
      this.url = this.buildUrl(this.params, this.baseUrl);
    }
  }

  getDefaultBaseUrl() {
    return YouTubeUploadClient.defaults.baseUrl;
  }

  isSuccessStatus(status) {
    return (status >= 200 && status < 300) || status === 308;
  }

  getUploadHeaders(end) {
    return {
      "Content-Type": this.contentType,
      "Content-Range": `bytes ${this.offset}-${end - 1}/${this.file.size}`,
      "X-Upload-Content-Type": this.file.type || this.contentType,
    };
  }

  async createUploadSession() {
    const xhr = await this.xhr({
      method: this.httpMethod,
      url: this.url,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Length": String(this.file.size),
        "X-Upload-Content-Type": this.contentType,
      },
      body: JSON.stringify(this.metadata),
    });

    const location = xhr.getResponseHeader("Location");
    if (!location) {
      throw new UploadVideoError(
        "errors.youtube_upload_location_missing",
        "Missing YouTube resumable upload Location header."
      );
    }

    this.url = location;
  }

  async resume() {
    try {
      const xhr = await this.xhr({
        method: "PUT",
        url: this.url,
        headers: {
          "Content-Range": `bytes */${this.file.size}`,
          "X-Upload-Content-Type": this.file.type || this.contentType,
        },
      });

      return await this.handleUploadSuccess(xhr);
    } catch (error) {
      return await this.handleUploadError(error);
    }
  }

  async handleUploadSuccess(xhr) {
    if (xhr.status === 200 || xhr.status === 201) {
      this.resetRetry();
      const parsed = this.parseJson(
        xhr.responseText,
        "Invalid YouTube upload response.",
        "errors.youtube_upload_response_invalid"
      );

      if (!parsed?.id) {
        throw new UploadVideoError(
          "errors.youtube_video_id_missing",
          "Missing YouTube video ID in upload response."
        );
      }

      this.videoId = parsed.id;
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
      "YouTube upload failed.",
      "errors.youtube_upload_failed"
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

  async fetchYoutubeUploadStatus(accessToken) {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(this.videoId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw data?.error?.message
        ? new Error(data.error.message)
        : new UploadVideoError(
            "errors.youtube_status_check_failed",
            "Failed to check YouTube video status."
          );
    }

    return data?.items?.[0] || null;
  }

  async waitForYoutubeProcessing(
    accessToken,
    { interval = 5000, timeout = 10 * 60 * 1000, shouldCancel = null } = {}
  ) {
    const startedAt = Date.now();

    while (true) {
      const video = await this.fetchYoutubeUploadStatus(accessToken);

      if (!video) {
        throw new UploadVideoError(
          "errors.youtube_video_not_found",
          "Uploaded YouTube video was not found."
        );
      }

      const uploadStatus = video.status?.uploadStatus;
      const processingStatus = video.processingDetails?.processingStatus;

      if (processingStatus === "succeeded" || uploadStatus === "processed") {
        return { video, timedOut: false };
      }

      if (processingStatus === "failed" || processingStatus === "terminated") {
        throw new UploadVideoError(
          "errors.youtube_processing_failed",
          `YouTube processing failed: ${processingStatus}`,
          { interpolationValues: { status: processingStatus } }
        );
      }

      if (["failed", "rejected", "deleted"].includes(uploadStatus)) {
        throw new UploadVideoError(
          "errors.youtube_upload_status_failed",
          `YouTube upload failed: ${uploadStatus}`,
          { interpolationValues: { status: uploadStatus } }
        );
      }

      if (Date.now() - startedAt > timeout) {
        // The upload itself already succeeded; YouTube keeps transcoding
        // server-side regardless of this client. For large files that
        // outlast the poll window we stop watching and let the caller insert
        // the (already valid) link rather than failing the whole upload.
        return { video, timedOut: true };
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
    return this.videoId;
  }

  async deleteVideo({ maxAttempts = 4, maxWaitMs = 60_000 } = {}) {
    if (!this.videoId) {
      return;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(this.videoId)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        }
      );

      if (response.ok) {
        return;
      }

      if (response.status !== 429 || attempt === maxAttempts) {
        throw new Error(`YouTube delete failed: ${response.status}`);
      }

      await sleep(Math.min(2 ** attempt * 1000, maxWaitMs));
    }
  }
}
