import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import ResumableUploadClient from "../../discourse/lib/upload-video/client";
import YouTubeUploadClient from "../../discourse/lib/upload-video/provider/youtube";

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
    assert.true(
      first >= 2000 && first <= 3000,
      "doubles the interval plus jitter"
    );

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
});
