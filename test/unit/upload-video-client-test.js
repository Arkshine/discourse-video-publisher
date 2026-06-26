import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import ResumableUploadClient from "../../discourse/lib/upload-video/client";
import CloudflareStreamUploadClient from "../../discourse/lib/upload-video/provider/cloudflare-stream";
import MuxUploadClient from "../../discourse/lib/upload-video/provider/mux";
import VimeoUploadClient from "../../discourse/lib/upload-video/provider/vimeo";
import YouTubeUploadClient from "../../discourse/lib/upload-video/provider/youtube";
import { CancelledError } from "../../discourse/lib/upload-video/util";

function makeClient(overrides = {}) {
  return new ResumableUploadClient({
    file: new Blob(["0123456789"]),
    token: "token",
    url: "https://example.com/upload",
    ...overrides,
  });
}

module("Unit | Lib | upload-video/client", function (hooks) {
  setupTest(hooks);

  test("constructor rejects a missing file", function (assert) {
    assert.throws(
      () => new ResumableUploadClient({ token: "token" }),
      /Missing or invalid file/,
      "requires a Blob"
    );
  });

  test("constructor rejects a missing token", function (assert) {
    assert.throws(
      () => new ResumableUploadClient({ file: new Blob(["x"]) }),
      /Missing bearer token/,
      "requires a bearer token"
    );
  });

  test("getChunk slices according to offset and chunk size", function (assert) {
    const client = makeClient({ chunkSize: 4 });

    let chunk = client.getChunk();
    assert.strictEqual(chunk.end, 4, "first chunk ends at the chunk size");
    assert.strictEqual(chunk.content.size, 4, "first chunk holds 4 bytes");

    client.offset = 8;
    chunk = client.getChunk();
    assert.strictEqual(chunk.end, 10, "last chunk is clamped to file size");
    assert.strictEqual(chunk.content.size, 2, "last chunk holds the remainder");
  });

  test("getChunk sends the whole file when chunking is disabled", function (assert) {
    const client = makeClient({ chunkSize: 0 });
    const chunk = client.getChunk();

    assert.strictEqual(chunk.end, 10, "ends at the file size");
    assert.strictEqual(chunk.content.size, 10, "sends the full file");
  });

  test("nextRetryInterval backs off exponentially and is capped", function (assert) {
    const client = makeClient({
      initialRetryInterval: 1000,
      maxRetryInterval: 3000,
    });

    const first = client.nextRetryInterval();
    assert.true(first >= 2000, "doubles the interval plus jitter");
    assert.true(first <= 3000, "stays within the jitter upper bound");

    client.retryInterval = 5000;
    assert.strictEqual(
      client.nextRetryInterval(),
      3000,
      "caps at maxRetryInterval"
    );
  });

  test("buildUrl appends query params", function (assert) {
    const client = makeClient();

    assert.strictEqual(
      client.buildUrl({ uploadType: "resumable" }, "https://example.com/api"),
      "https://example.com/api?uploadType=resumable",
      "serializes params onto the base URL"
    );
    assert.strictEqual(
      client.buildUrl({}, "https://example.com/api"),
      "https://example.com/api",
      "leaves the URL untouched without params"
    );
  });

  test("throwIfCancelled throws only after a cancel is requested", function (assert) {
    const client = makeClient();

    client.throwIfCancelled();
    assert.true(true, "does not throw before a cancel");

    client.cancelRequested = true;
    assert.throws(
      () => client.throwIfCancelled(),
      /cancelled/i,
      "throws once a cancel is requested"
    );
  });

  test("parseJson handles empty, valid, and invalid payloads", function (assert) {
    const client = makeClient();

    assert.deepEqual(client.parseJson(""), {}, "empty text yields {}");
    assert.deepEqual(
      client.parseJson('{"a":1}'),
      { a: 1 },
      "parses valid JSON"
    );
    assert.throws(
      () => client.parseJson("not json"),
      /Invalid JSON response/,
      "throws on malformed JSON"
    );
  });

  test("retry throws once the elapsed retry window is exceeded", async function (assert) {
    const client = makeClient({ maxRetryElapsedMillis: 0 });
    client.retryStartedAt = Date.now() - 10;

    try {
      await client.retry(() => "nope");
      assert.true(false, "expected a timeout error");
    } catch (error) {
      assert.strictEqual(
        error.translationKey,
        "errors.upload_retry_timeout",
        "raises the retry timeout error"
      );
    }
  });

  test("retryTransientError retries a transient 5xx error", async function (assert) {
    const client = makeClient({ initialRetryInterval: 1 });
    let calls = 0;

    const result = await client.retryTransientError({ status: 503 }, () => {
      calls++;
      return "ok";
    });

    assert.strictEqual(result, "ok", "returns the retry result");
    assert.strictEqual(calls, 1, "invokes the retry callback once");
  });

  test("retryTransientError retries a 429 rate-limit error", async function (assert) {
    const client = makeClient({ initialRetryInterval: 1 });
    let calls = 0;

    const result = await client.retryTransientError({ status: 429 }, () => {
      calls++;
      return "ok";
    });

    assert.strictEqual(result, "ok", "returns the retry result");
    assert.strictEqual(calls, 1, "retries instead of failing on a rate limit");
  });

  test("retryTransientError rethrows a non-transient error", async function (assert) {
    const client = makeClient();
    const original = { status: 400 };

    try {
      await client.retryTransientError(original, () => "retried");
      assert.true(false, "expected the original error");
    } catch (error) {
      assert.strictEqual(error, original, "propagates the 4xx error");
    }
  });

  test("retryTransientError converts a cancel into a CancelledError", async function (assert) {
    const client = makeClient();
    client.cancelRequested = true;

    try {
      await client.retryTransientError({ status: 500 }, () => "retried");
      assert.true(false, "expected a cancelled error");
    } catch (error) {
      assert.true(error.cancelled, "rejects with a cancelled error");
    }
  });

  test("cancel during a paused retry rejects without resuming", async function (assert) {
    const client = makeClient();
    client.isPaused = true;
    let called = false;

    const promise = client.retryTransientError({ status: 500 }, () => {
      called = true;
      return "resumed";
    });

    client.cancel();

    try {
      await promise;
      assert.true(false, "expected a cancelled error");
    } catch (error) {
      assert.true(error.cancelled, "rejects with a cancelled error");
    }

    assert.false(called, "does not run the retry callback");
  });

  test("unpause resumes a paused retry", async function (assert) {
    const client = makeClient();
    client.isPaused = true;
    let called = false;

    const promise = client.retryTransientError({ status: 500 }, () => {
      called = true;
      return "resumed";
    });

    client.unpause();

    assert.strictEqual(await promise, "resumed", "runs the retry callback");
    assert.true(called, "resumes the upload after unpause");
  });
});

module("Unit | Lib | upload-video/provider/youtube", function (hooks) {
  setupTest(hooks);

  function makeYoutubeClient() {
    return new YouTubeUploadClient({
      file: new Blob(["0123456789"]),
      token: "token",
    });
  }

  test("treats 308 as a success status", function (assert) {
    const client = makeYoutubeClient();

    assert.true(client.isSuccessStatus(308), "308 continues the upload");
    assert.true(client.isSuccessStatus(200), "200 is a success");
    assert.false(client.isSuccessStatus(500), "500 is a failure");
  });

  test("extractRangeOffset reads the next offset from the Range header", function (assert) {
    const client = makeYoutubeClient();
    const xhrWith = (range) => ({ getResponseHeader: () => range });

    assert.strictEqual(
      client.extractRangeOffset(xhrWith("bytes=0-12345")),
      12346,
      "resumes after the last received byte"
    );
    assert.strictEqual(
      client.extractRangeOffset(xhrWith(null)),
      null,
      "returns null without a Range header"
    );
    assert.strictEqual(
      client.extractRangeOffset(xhrWith("bytes")),
      null,
      "returns null when the header has no digits"
    );
  });

  test("waitForYoutubeProcessing returns the video once processing succeeds", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => ({
      id: "abc",
      status: { uploadStatus: "processed" },
      processingDetails: { processingStatus: "succeeded" },
    });

    const result = await client.waitForYoutubeProcessing("token");

    assert.false(result.timedOut, "does not report a timeout");
    assert.strictEqual(result.video.id, "abc", "returns the fetched video");
  });

  test("waitForYoutubeProcessing returns timedOut without throwing when processing is slow", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => ({
      id: "abc",
      status: { uploadStatus: "uploaded" },
      processingDetails: { processingStatus: "processing" },
    });

    const result = await client.waitForYoutubeProcessing("token", {
      timeout: -1,
    });

    assert.true(result.timedOut, "reports the timeout instead of throwing");
    assert.strictEqual(
      result.video.id,
      "abc",
      "still returns the in-progress video so the link can be inserted"
    );
  });

  test("waitForYoutubeProcessing throws when processing fails", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => ({
      id: "abc",
      status: { uploadStatus: "uploaded" },
      processingDetails: { processingStatus: "failed" },
    });

    await assert.rejects(
      client.waitForYoutubeProcessing("token"),
      (error) =>
        /YouTube processing failed/.test(error.message) &&
        error.cleanup === true,
      "a genuine processing failure is surfaced and flagged for cleanup"
    );
  });

  test("waitForYoutubeProcessing throws CancelledError when cancelled", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => ({
      id: "abc",
      status: { uploadStatus: "uploaded" },
      processingDetails: { processingStatus: "processing" },
    });

    await assert.rejects(
      client.waitForYoutubeProcessing("token", {
        shouldCancel: () => true,
      }),
      CancelledError,
      "cancellation still aborts the wait"
    );
  });

  test("waitForYoutubeProcessing retries a transient status-check failure", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    let calls = 0;
    client.fetchYoutubeUploadStatus = async () => {
      calls++;
      if (calls === 1) {
        const error = new Error("rate limited");
        error.status = 429;
        throw error;
      }
      return {
        id: "abc",
        status: { uploadStatus: "processed" },
        processingDetails: { processingStatus: "succeeded" },
      };
    };

    const result = await client.waitForYoutubeProcessing("token", {
      interval: 1,
    });

    assert.false(result.timedOut, "does not fail on the transient error");
    assert.strictEqual(result.video.id, "abc", "returns the video after retry");
    assert.strictEqual(calls, 2, "polled again after the rate limit");
  });

  test("waitForYoutubeProcessing gives up gracefully when status checks keep failing", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => {
      const error = new Error("rate limited");
      error.status = 429;
      throw error;
    };

    const result = await client.waitForYoutubeProcessing("token", {
      timeout: -1,
    });

    assert.true(result.timedOut, "reports a timeout instead of throwing");
    assert.strictEqual(
      result.video,
      null,
      "no video, so the caller falls back to the known id"
    );
  });

  test("waitForYoutubeProcessing surfaces a non-transient status error", async function (assert) {
    const client = makeYoutubeClient();
    client.videoId = "abc";
    client.fetchYoutubeUploadStatus = async () => {
      const error = new Error("forbidden");
      error.status = 403;
      throw error;
    };

    await assert.rejects(
      client.waitForYoutubeProcessing("token"),
      /forbidden/,
      "a genuine error still aborts"
    );
  });
});

module("Unit | Lib | upload-video/provider/vimeo", function (hooks) {
  setupTest(hooks);

  function makeVimeoClient() {
    return new VimeoUploadClient({
      file: new Blob(["0123456789"]),
      token: "token",
    });
  }

  test("waitForTranscode returns once transcoding completes", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => ({
      status: "available",
      transcode: "complete",
    });

    const result = await client.waitForTranscode();

    assert.false(result.timedOut, "does not report a timeout");
    assert.strictEqual(result.status, "complete", "returns the final status");
  });

  test("waitForTranscode returns timedOut without throwing when transcoding is slow", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => ({
      status: "transcoding",
      transcode: "in_progress",
    });

    const result = await client.waitForTranscode({ timeout: -1 });

    assert.true(result.timedOut, "reports the timeout instead of throwing");
    assert.strictEqual(
      result.status,
      "in_progress",
      "still returns the in-progress status so the link can be inserted"
    );
  });

  test("waitForTranscode throws when transcoding fails", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => ({
      status: "transcoding",
      transcode: "error",
    });

    await assert.rejects(
      client.waitForTranscode(),
      /could not process this video/,
      "a genuine transcoding failure is still surfaced"
    );
  });

  test("waitForTranscode fails fast on an upload error even while transcode stays in_progress", async function (assert) {
    const client = makeVimeoClient();
    let calls = 0;
    client.fetchStatus = async () => {
      calls++;
      return { status: "uploading_error", transcode: "in_progress" };
    };

    await assert.rejects(
      client.waitForTranscode({ interval: 1 }),
      (error) =>
        /could not process this video/.test(error.message) &&
        error.cleanup === true,
      "an uploading_error stops the wait and flags the video for cleanup"
    );
    assert.strictEqual(calls, 1, "stops on the first poll, no flooding");
  });

  test("waitForTranscode surfaces a quota error distinctly", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => ({
      status: "quota_exceeded",
      transcode: "in_progress",
    });

    await assert.rejects(
      client.waitForTranscode({ interval: 1 }),
      /upload limit/,
      "quota failures get their own message"
    );
  });

  test("waitForTranscode throws CancelledError when cancelled", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => ({
      status: "transcoding",
      transcode: "in_progress",
    });

    await assert.rejects(
      client.waitForTranscode({ shouldCancel: () => true }),
      CancelledError,
      "cancellation still aborts the wait"
    );
  });

  test("waitForTranscode retries a transient status-check failure", async function (assert) {
    const client = makeVimeoClient();
    let calls = 0;
    client.fetchStatus = async () => {
      calls++;
      if (calls === 1) {
        const error = new Error("server error");
        error.status = 503;
        throw error;
      }
      return { status: "available", transcode: "complete" };
    };

    const result = await client.waitForTranscode({ interval: 1 });

    assert.false(result.timedOut, "does not fail on the transient error");
    assert.strictEqual(result.status, "complete", "completes after retry");
    assert.strictEqual(calls, 2, "polled again after the server error");
  });

  test("waitForTranscode surfaces a non-transient status error", async function (assert) {
    const client = makeVimeoClient();
    client.fetchStatus = async () => {
      const error = new Error("bad request");
      error.status = 400;
      throw error;
    };

    await assert.rejects(
      client.waitForTranscode(),
      /bad request/,
      "a genuine error still aborts"
    );
  });
});

module(
  "Unit | Lib | upload-video/provider/cloudflare-stream",
  function (hooks) {
    setupTest(hooks);

    function makeClient() {
      return new CloudflareStreamUploadClient({
        file: new Blob(["0123456789"]),
        token: "broker-token",
        brokerOrigin: "https://broker.test",
        metadata: { title: "clip" },
      });
    }

    test("getResult returns the iframe url", function (assert) {
      const client = makeClient();
      client.iframeUrl = "https://iframe.videodelivery.net/uid123";
      assert.strictEqual(
        client.getResult(),
        "https://iframe.videodelivery.net/uid123"
      );
    });

    test("waitForReady returns once the video is ready", async function (assert) {
      const client = makeClient();
      client.fetchStatus = async () => ({
        ready: true,
        status: "ready",
        iframe_url: "https://iframe.videodelivery.net/uid123",
      });

      const result = await client.waitForReady();

      assert.false(result.timedOut, "does not report a timeout");
      assert.strictEqual(
        result.iframeUrl,
        "https://iframe.videodelivery.net/uid123"
      );
    });

    test("waitForReady reports timedOut without throwing when processing is slow", async function (assert) {
      const client = makeClient();
      client.fetchStatus = async () => ({ ready: false, status: "inprogress" });

      const result = await client.waitForReady({ timeout: -1 });

      assert.true(result.timedOut, "reports the timeout instead of throwing");
    });

    test("waitForReady throws and flags cleanup on an error status", async function (assert) {
      const client = makeClient();
      client.fetchStatus = async () => ({ ready: false, status: "error" });

      await assert.rejects(
        client.waitForReady({ interval: 1 }),
        (error) =>
          /could not process this video/.test(error.message) &&
          error.cleanup === true,
        "an error status stops the wait and flags cleanup"
      );
    });

    test("waitForReady throws CancelledError when cancelled", async function (assert) {
      const client = makeClient();
      client.fetchStatus = async () => ({ ready: false, status: "inprogress" });

      await assert.rejects(
        client.waitForReady({ shouldCancel: () => true }),
        CancelledError
      );
    });

    test("waitForReady inserts early while still processing", async function (assert) {
      const client = makeClient();
      client.iframeUrl = "https://iframe.videodelivery.net/uid123";
      client.fetchStatus = async () => ({ ready: false, status: "inprogress" });

      let announced = null;
      const result = await client.waitForReady({
        onEmbeddable: (url) => (announced = url),
        shouldInsertEarly: () => true,
      });

      assert.false(result.timedOut, "does not report a timeout");
      assert.strictEqual(
        result.iframeUrl,
        "https://iframe.videodelivery.net/uid123",
        "returns the embed url before the video is ready"
      );
      assert.strictEqual(
        announced,
        "https://iframe.videodelivery.net/uid123",
        "announces the embeddable url"
      );
    });

    test("createUploadSession switches to simple mode for basic_post", async function (assert) {
      const client = makeClient();
      client.xhr = async () => ({
        responseText: JSON.stringify({
          upload_type: "basic_post",
          upload_url: "https://upload.videodelivery.net/basic",
          uid: "uid123",
          status_url: "https://broker.test/videos/uid123",
          iframe_url: "https://iframe.videodelivery.net/uid123",
        }),
      });

      await client.createUploadSession();

      assert.true(client.simpleMode, "flags basic_post as simple mode");
      assert.strictEqual(client.uid, "uid123");
      assert.strictEqual(
        client.iframeUrl,
        "https://iframe.videodelivery.net/uid123"
      );
    });

    test("createUploadSession sets the tus upload url for tus mode", async function (assert) {
      const client = makeClient();
      client.xhr = async () => ({
        responseText: JSON.stringify({
          upload_type: "tus",
          upload_url: "https://upload.videodelivery.net/tus/uid123",
          uid: "uid123",
          status_url: "https://broker.test/videos/uid123",
          iframe_url: "https://iframe.videodelivery.net/uid123",
        }),
      });

      await client.createUploadSession();

      assert.false(client.simpleMode, "tus is not simple mode");
      assert.strictEqual(
        client.url,
        "https://upload.videodelivery.net/tus/uid123"
      );
    });
  }
);

module("Unit | Lib | upload-video/provider/mux", function (hooks) {
  setupTest(hooks);

  function makeClient() {
    return new MuxUploadClient({
      file: new Blob(["0123456789"]),
      token: "broker-token",
      brokerOrigin: "https://broker.test",
      metadata: { title: "clip" },
    });
  }

  test("treats 308 as a success status", function (assert) {
    const client = makeClient();
    assert.true(client.isSuccessStatus(308));
    assert.true(client.isSuccessStatus(201));
    assert.false(client.isSuccessStatus(500));
  });

  test("getUploadHeaders sets a Content-Range", function (assert) {
    const client = makeClient();
    const headers = client.getUploadHeaders(10);
    assert.strictEqual(headers["Content-Range"], "bytes 0-9/10");
  });

  test("createUploadSession stores the GCS upload url and status url", async function (assert) {
    const client = makeClient();
    client.xhr = async () => ({
      responseText: JSON.stringify({
        upload_id: "up_1",
        upload_url: "https://storage.googleapis.com/session",
        status_url: "https://broker.test/mux/uploads/up_1",
      }),
    });

    await client.createUploadSession();

    assert.strictEqual(client.url, "https://storage.googleapis.com/session");
    assert.strictEqual(client.uploadId, "up_1");
    assert.strictEqual(
      client.statusUrl,
      "https://broker.test/mux/uploads/up_1"
    );
  });

  test("createUploadSession throws when the upload url is missing", async function (assert) {
    const client = makeClient();
    client.xhr = async () => ({
      responseText: JSON.stringify({ upload_id: "up_1" }),
    });

    await assert.rejects(
      client.createUploadSession(),
      (error) => error.translationKey === "errors.mux_upload_url_missing"
    );
  });

  test("waitForReady returns the player url once ready", async function (assert) {
    const client = makeClient();
    client.fetchStatus = async () => ({
      ready: true,
      asset_status: "ready",
      iframe_url: "https://player.mux.com/pb1",
    });

    const result = await client.waitForReady();

    assert.false(result.timedOut);
    assert.strictEqual(result.iframeUrl, "https://player.mux.com/pb1");
  });

  test("waitForReady reports timedOut without throwing when processing is slow", async function (assert) {
    const client = makeClient();
    client.fetchStatus = async () => ({
      ready: false,
      asset_status: "preparing",
    });

    const result = await client.waitForReady({ timeout: -1 });

    assert.true(result.timedOut);
  });

  test("waitForReady throws and flags cleanup when the asset errors", async function (assert) {
    const client = makeClient();
    client.fetchStatus = async () => ({
      ready: false,
      asset_status: "errored",
    });

    await assert.rejects(
      client.waitForReady({ interval: 1 }),
      (error) =>
        /could not process this video/.test(error.message) &&
        error.cleanup === true
    );
  });

  test("waitForReady throws CancelledError when cancelled", async function (assert) {
    const client = makeClient();
    client.fetchStatus = async () => ({
      ready: false,
      asset_status: "preparing",
    });

    await assert.rejects(
      client.waitForReady({ shouldCancel: () => true }),
      CancelledError
    );
  });

  test("waitForReady inserts early once the player url is known", async function (assert) {
    const client = makeClient();
    client.fetchStatus = async () => ({
      ready: false,
      asset_status: "preparing",
      iframe_url: "https://player.mux.com/pb1",
    });

    let announced = null;
    const result = await client.waitForReady({
      interval: 1,
      onEmbeddable: (url) => (announced = url),
      shouldInsertEarly: () => true,
    });

    assert.false(result.timedOut, "does not report a timeout");
    assert.strictEqual(
      result.iframeUrl,
      "https://player.mux.com/pb1",
      "returns the player url before the asset is ready"
    );
    assert.strictEqual(
      announced,
      "https://player.mux.com/pb1",
      "announces the embeddable url once the asset is created"
    );
  });
});
