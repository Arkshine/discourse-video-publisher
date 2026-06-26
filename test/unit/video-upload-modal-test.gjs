import { click, render, triggerEvent, waitUntil } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "discourse/tests/helpers/component-test";
import { i18n } from "discourse-i18n";
import VideoUpload from "../../discourse/components/modal/video-upload";

module("Unit | Component | modal/video-upload", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    this.owner.lookup("service:modal").containerElement =
      document.querySelector("#ember-testing");

    settings.youtube_upload_enabled = true;
    settings.vimeo_upload_enabled = false;
    settings.cloudflare_stream_upload_enabled = false;
    settings.mux_upload_enabled = false;
    settings.max_upload_size_mb = 0;
    settings.max_duration_minutes = 0;
  });

  test("selecting a video shows the chip and autofills the title", async function (assert) {
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    const file = new File(["video"], "holiday.mp4", { type: "video/mp4" });
    await triggerEvent(".video-drop-zone input[type='file']", "change", {
      files: [file],
    });

    assert.dom(".video-drop-zone__chip").exists();
    assert.dom(".video-drop-zone__file-name").hasText("holiday.mp4");
    assert
      .dom(".form-kit__field[data-name='title'] input")
      .hasValue("holiday.mp4");
  });

  test("clearing the selected file resets the dropzone", async function (assert) {
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    const file = new File(["video"], "holiday.mp4", { type: "video/mp4" });
    await triggerEvent(".video-drop-zone input[type='file']", "change", {
      files: [file],
    });

    assert.dom(".video-drop-zone__chip").exists();

    await click(".video-drop-zone__clear");

    assert.dom(".video-drop-zone__chip").doesNotExist();
    assert.dom(".video-drop-zone__browse").exists();
  });

  test("rejects non-video files with a validation error", async function (assert) {
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    await triggerEvent(".video-drop-zone input[type='file']", "change", {
      files: [file],
    });

    assert.dom(".video-drop-zone__chip").doesNotExist();
    assert
      .dom(".form-kit__field[data-name='video'] .form-kit__errors")
      .includesText(i18n(themePrefix("validation.video.invalid")));
  });

  test("rejects non-video files dropped on the drop zone", async function (assert) {
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["text"], "notes.txt", { type: "text/plain" })
    );

    await triggerEvent(".video-drop-zone", "drop", { dataTransfer });
    await waitUntil(() =>
      document.querySelector(
        ".form-kit__field[data-name='video'] .form-kit__errors"
      )
    );

    assert.dom(".video-drop-zone__chip").doesNotExist();
    assert
      .dom(".form-kit__field[data-name='video'] .form-kit__errors")
      .includesText(i18n(themePrefix("validation.video.invalid")));
  });

  test("single provider: the full form shows immediately on open", async function (assert) {
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    assert
      .dom(".form-kit__control-radio")
      .doesNotExist("no provider cards when only one provider is enabled");
    assert.dom(".video-upload-form-reveal").exists();
    assert.dom(".video-drop-zone").exists();
    assert.dom(".form-kit__field[data-name='title']").exists();
    assert
      .dom(
        ".form-kit__field[data-name='description'] textarea.form-kit__control-textarea"
      )
      .exists("description renders as a multi-line textarea");
    assert
      .dom(".d-modal__footer .btn-primary")
      .hasText(i18n(themePrefix("upload.youtube")));
  });

  test("single provider (vimeo): the full form shows immediately on open", async function (assert) {
    settings.youtube_upload_enabled = false;
    settings.vimeo_upload_enabled = true;
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    assert
      .dom(".form-kit__control-radio")
      .doesNotExist("no provider cards when only one provider is enabled");
    assert.dom(".video-upload-form-reveal").exists();
    assert.dom(".video-drop-zone").exists();
    assert.dom(".form-kit__field[data-name='title']").exists();
    assert
      .dom(".d-modal__footer .btn-primary")
      .hasText(i18n(themePrefix("upload.vimeo")));
  });

  test("dual providers: opens with only the provider cards and a hint", async function (assert) {
    settings.vimeo_upload_enabled = true;
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    assert.dom(".form-kit__control-radio[value='youtube']").exists();
    assert.dom(".form-kit__control-radio[value='vimeo']").exists();
    assert
      .dom(".video-upload-provider-choice__hint")
      .hasText(i18n(themePrefix("provider.choose_hint")));
    assert.dom(".video-upload-provider-choice.--empty").exists();

    assert.dom(".video-upload-form-reveal").doesNotExist();
    assert.dom(".video-drop-zone").doesNotExist();
    assert.dom(".form-kit__field[data-name='title']").doesNotExist();
    assert.dom(".form-kit__field[data-name='description']").doesNotExist();
    assert.dom(".d-modal__footer .btn-primary").doesNotExist();
  });

  test("renders a radio card for each enabled provider", async function (assert) {
    settings.vimeo_upload_enabled = true;
    settings.cloudflare_stream_upload_enabled = true;
    settings.mux_upload_enabled = true;
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    assert.dom(".form-kit__control-radio[value='youtube']").exists();
    assert.dom(".form-kit__control-radio[value='vimeo']").exists();
    assert.dom(".form-kit__control-radio[value='cloudflare_stream']").exists();
    assert.dom(".form-kit__control-radio[value='mux']").exists();
  });

  test("exceedsMaxSize respects the configured limit", function (assert) {
    const exceedsMaxSize = VideoUpload.prototype.exceedsMaxSize;

    settings.max_upload_size_mb = 0;
    assert.false(
      exceedsMaxSize.call({}, { size: 999_999_999 }),
      "a limit of 0 disables the check"
    );

    settings.max_upload_size_mb = 1;
    assert.true(
      exceedsMaxSize.call({}, { size: 2 * 1024 * 1024 }),
      "rejects a file over the limit"
    );
    assert.false(
      exceedsMaxSize.call({}, { size: 500 * 1024 }),
      "allows a file under the limit"
    );
  });

  test("durationExceedsLimit respects the configured limit", function (assert) {
    const durationExceedsLimit = VideoUpload.prototype.durationExceedsLimit;

    settings.max_duration_minutes = 0;
    assert.false(
      durationExceedsLimit.call({}, 99_999),
      "a limit of 0 disables the check"
    );

    settings.max_duration_minutes = 5;
    assert.true(
      durationExceedsLimit.call({}, 6 * 60),
      "rejects a video over the limit"
    );
    assert.false(
      durationExceedsLimit.call({}, 4 * 60),
      "allows a video under the limit"
    );
    assert.false(
      durationExceedsLimit.call({}, null),
      "allows when the duration is unknown"
    );
  });

  test("progressBarStyle derives a safe width style from uploadProgress", function (assert) {
    const get = Object.getOwnPropertyDescriptor(
      VideoUpload.prototype,
      "progressBarStyle"
    ).get;

    assert.strictEqual(get.call({ uploadProgress: 0 }).toString(), "width: 0%");
    assert.strictEqual(
      get.call({ uploadProgress: 42 }).toString(),
      "width: 42%"
    );
    assert.strictEqual(
      get.call({ uploadProgress: 100 }).toString(),
      "width: 100%"
    );
  });

  test("dual providers: picking a provider reveals the form and submit button", async function (assert) {
    settings.vimeo_upload_enabled = true;
    const noop = () => {};

    await render(<template><VideoUpload @closeModal={{noop}} /></template>);

    await click(".form-kit__control-radio[value='youtube']");

    assert
      .dom(".form-kit__control-radio[value='vimeo']")
      .exists("the other provider card stays visible after selection");
    assert.dom(".video-upload-form-reveal").exists();
    assert.dom(".video-drop-zone").exists();
    assert.dom(".form-kit__field[data-name='title']").exists();
    assert.dom(".video-upload-provider-choice__hint").doesNotExist();
    assert.dom(".video-upload-provider-choice.--empty").doesNotExist();
    assert
      .dom(".d-modal__footer .btn-primary")
      .hasText(i18n(themePrefix("upload.youtube")));
  });
});
