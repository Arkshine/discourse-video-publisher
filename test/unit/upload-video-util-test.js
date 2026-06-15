import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import { i18n } from "discourse-i18n";
import {
  CancelledError,
  uploadErrorMessage,
  UploadVideoError,
} from "../../discourse/lib/upload-video/util";

module("Unit | Lib | upload-video/util", function (hooks) {
  setupTest(hooks);

  test("uploadErrorMessage translates UploadVideoError via its key", function (assert) {
    const error = new UploadVideoError(
      "errors.network_error",
      "Network error during upload request."
    );

    assert.strictEqual(
      uploadErrorMessage(error),
      i18n(themePrefix("errors.network_error")),
      "returns the translated message for the error key"
    );
  });

  test("uploadErrorMessage interpolates values", function (assert) {
    const error = new UploadVideoError(
      "errors.youtube_processing_failed",
      "YouTube processing failed: failed",
      { interpolationValues: { status: "failed" } }
    );

    assert.strictEqual(
      uploadErrorMessage(error),
      i18n(themePrefix("errors.youtube_processing_failed"), {
        status: "failed",
      }),
      "passes interpolation values to the translation"
    );
  });

  test("uploadErrorMessage unwraps a plain Error message", function (assert) {
    assert.strictEqual(
      uploadErrorMessage(new Error("boom")),
      "boom",
      "returns the raw error message"
    );
  });

  test("uploadErrorMessage parses a JSON error payload", function (assert) {
    const payload = JSON.stringify({ error: { message: "nested message" } });

    assert.strictEqual(
      uploadErrorMessage(payload),
      "nested message",
      "extracts the nested error message"
    );
  });

  test("uploadErrorMessage maps Vimeo privacy error code 2410", function (assert) {
    const payload = JSON.stringify({
      invalid_parameters: [{ field: "privacy.view", error_code: 2410 }],
    });

    assert.strictEqual(
      uploadErrorMessage(payload),
      i18n(themePrefix("errors.vimeo_privacy_view_unavailable")),
      "returns the dedicated privacy translation"
    );
  });

  test("uploadErrorMessage returns non-JSON strings unchanged", function (assert) {
    assert.strictEqual(
      uploadErrorMessage("plain failure"),
      "plain failure",
      "returns the string as-is"
    );
  });

  test("CancelledError is flagged as cancelled", function (assert) {
    const error = new CancelledError();

    assert.true(error.cancelled, "sets the cancelled flag");
  });
});
