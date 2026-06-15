import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import ResumableUploadClient from "../../discourse/lib/upload-video/client";
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
      /YouTube processing failed/,
      "a genuine processing failure is still surfaced"
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
    client.transcodeStatus = async () => "complete";

    const result = await client.waitForTranscode();

    assert.false(result.timedOut, "does not report a timeout");
    assert.strictEqual(result.status, "complete", "returns the final status");
  });

  test("waitForTranscode returns timedOut without throwing when transcoding is slow", async function (assert) {
    const client = makeVimeoClient();
    client.transcodeStatus = async () => "in_progress";

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
    client.transcodeStatus = async () => "error";

    await assert.rejects(
      client.waitForTranscode(),
      /Vimeo transcoding failed/,
      "a genuine transcoding failure is still surfaced"
    );
  });

  test("waitForTranscode throws CancelledError when cancelled", async function (assert) {
    const client = makeVimeoClient();
    client.transcodeStatus = async () => "in_progress";

    await assert.rejects(
      client.waitForTranscode({ shouldCancel: () => true }),
      CancelledError,
      "cancellation still aborts the wait"
    );
  });
});
