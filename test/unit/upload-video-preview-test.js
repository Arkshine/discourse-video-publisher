import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import {
  extractVideoPreview,
  formatDuration,
  resolutionLabel,
} from "../../discourse/lib/upload-video/video-preview";

module("Unit | Lib | upload-video/video-preview", function (hooks) {
  setupTest(hooks);

  test("formatDuration formats sub-minute durations", function (assert) {
    assert.strictEqual(formatDuration(7), "0:07", "pads the seconds");
    assert.strictEqual(formatDuration(59), "0:59", "stays under a minute");
  });

  test("formatDuration formats minutes", function (assert) {
    assert.strictEqual(formatDuration(154), "2:34", "minutes and seconds");
    assert.strictEqual(formatDuration(62), "1:02", "pads the seconds");
  });

  test("formatDuration formats hour-plus durations", function (assert) {
    assert.strictEqual(formatDuration(3723), "1:02:03", "hours, minutes, secs");
  });

  test("formatDuration guards invalid input", function (assert) {
    assert.strictEqual(formatDuration(NaN), null, "guards NaN");
    assert.strictEqual(formatDuration(Infinity), null, "guards Infinity");
    assert.strictEqual(formatDuration(null), null, "guards null");
  });

  test("resolutionLabel maps each standard tier", function (assert) {
    assert.strictEqual(resolutionLabel(3840, 2160), "4K", "2160 tier");
    assert.strictEqual(resolutionLabel(2560, 1440), "1440p", "1440 tier");
    assert.strictEqual(resolutionLabel(1920, 1080), "1080p", "1080 tier");
    assert.strictEqual(resolutionLabel(1280, 720), "720p", "720 tier");
    assert.strictEqual(resolutionLabel(854, 480), "480p", "480 tier");
  });

  test("resolutionLabel falls back to dimensions for non-standard heights", function (assert) {
    assert.strictEqual(
      resolutionLabel(640, 360),
      "640×360",
      "uses width×height"
    );
  });

  test("resolutionLabel returns null for missing dimensions", function (assert) {
    assert.strictEqual(resolutionLabel(0, 0), null, "guards missing dims");
    assert.strictEqual(resolutionLabel(1920, 0), null, "guards missing height");
    assert.strictEqual(resolutionLabel(null, null), null, "guards null");
  });

  test("extractVideoPreview resolves null and revokes the URL on error", async function (assert) {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalCreateElement = document.createElement.bind(document);

    let revoked = false;
    URL.createObjectURL = () => "blob:stub";
    URL.revokeObjectURL = () => {
      revoked = true;
    };

    // Stub <video> so it fires "error" instead of decoding.
    document.createElement = function (tag) {
      if (tag === "video") {
        const video = originalCreateElement("div");
        let errorHandler;
        video.addEventListener = (type, handler) => {
          if (type === "error") {
            errorHandler = handler;
          }
        };
        Object.defineProperty(video, "src", {
          set() {
            setTimeout(() => errorHandler?.(), 0);
          },
        });
        return video;
      }
      return originalCreateElement(tag);
    };

    try {
      const result = await extractVideoPreview(new Blob(["x"]), {
        timeoutMs: 50,
      });
      assert.strictEqual(result, null, "resolves null on a decode error");
      assert.true(revoked, "revokes the object URL");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      document.createElement = originalCreateElement;
    }
  });
});
