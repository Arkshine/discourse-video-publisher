import { click, render, triggerEvent, waitUntil } from "@ember/test-helpers";
import { module, test } from "qunit";
import sinon from "sinon";
import { setupRenderingTest } from "discourse/tests/helpers/component-test";
import I18n, { i18n } from "discourse-i18n";
import VideoDropZone from "../../discourse/components/video-drop-zone";

// Fakes a decodable <video> + <canvas> so extractVideoPreview produces a
// preview without a real codec. Returns a teardown that restores createElement.
function stubVideoPreview({
  duration = 154,
  width = 1920,
  height = 1080,
} = {}) {
  const original = document.createElement.bind(document);

  // Only fake the elements extractVideoPreview creates (the first video +
  // canvas). Subsequent createElement calls — notably the template's real
  // <video> player rendered on expand — must pass through to the DOM.
  let videoFaked = false;
  let canvasFaked = false;

  sinon.stub(document, "createElement").callsFake((tag) => {
    if (tag === "video" && !videoFaked) {
      videoFaked = true;
      const handlers = {};
      const video = {
        addEventListener: (type, handler) => (handlers[type] = handler),
        get duration() {
          return duration;
        },
        get videoWidth() {
          return width;
        },
        get videoHeight() {
          return height;
        },
        set src(_value) {
          setTimeout(() => handlers.loadedmetadata?.(), 0);
        },
        set currentTime(_value) {
          setTimeout(() => handlers.seeked?.(), 0);
        },
      };
      return video;
    }

    if (tag === "canvas" && !canvasFaked) {
      canvasFaked = true;
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => "data:image/jpeg;base64,stub",
      };
    }

    return original(tag);
  });
}

module("Unit | Component | video-drop-zone", function (hooks) {
  setupRenderingTest(hooks);

  hooks.afterEach(function () {
    sinon.restore();
  });

  test("renders the empty state with hint and browse button", async function (assert) {
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone @file={{null}} @onFileSelected={{noop}} />
      </template>
    );

    assert
      .dom(".video-drop-zone__hint")
      .hasText(i18n(themePrefix("upload.drop_hint")));
    assert.dom(".video-drop-zone__browse").exists();
    assert.dom(".video-drop-zone input[type='file']").exists();
    assert.dom(".video-drop-zone__chip").doesNotExist();
  });

  test("shows a chip with file name, size and clear button when a file is selected", async function (assert) {
    const file = new File(["x".repeat(2048)], "holiday.mp4", {
      type: "video/mp4",
    });
    let cleared = false;
    const onClear = () => {
      cleared = true;
    };
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone
          @file={{file}}
          @onFileSelected={{noop}}
          @onClear={{onClear}}
        />
      </template>
    );

    assert.dom(".video-drop-zone__file-name").hasText("holiday.mp4");
    assert
      .dom(".video-drop-zone__file-size")
      .hasText(I18n.toHumanSize(file.size));
    assert.dom(".video-drop-zone__browse").doesNotExist();

    await click(".video-drop-zone__clear");

    assert.true(cleared, "clicking the clear button calls @onClear");
  });

  test("forwards files picked through the file input", async function (assert) {
    let selected = null;
    const onFileSelected = (files) => {
      selected = files[0];
    };

    await render(
      <template>
        <VideoDropZone @file={{null}} @onFileSelected={{onFileSelected}} />
      </template>
    );

    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    await triggerEvent(".video-drop-zone input[type='file']", "change", {
      files: [file],
    });

    assert.strictEqual(selected?.name, "clip.mp4");
  });

  test("highlights while a file is dragged over", async function (assert) {
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone @file={{null}} @onFileSelected={{noop}} />
      </template>
    );

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["video"], "clip.mp4", { type: "video/mp4" })
    );

    await triggerEvent(".video-drop-zone", "dragenter", { dataTransfer });
    await triggerEvent(".video-drop-zone", "dragover", { dataTransfer });

    assert.dom(".video-drop-zone").hasClass("uppy-is-drag-over");

    await triggerEvent(".video-drop-zone", "dragleave", { dataTransfer });

    assert.dom(".video-drop-zone").hasNoClass("uppy-is-drag-over");
  });

  test("forwards a dropped file to @onFileSelected", async function (assert) {
    let selected = null;
    const onFileSelected = (files) => {
      selected = files;
    };

    await render(
      <template>
        <VideoDropZone @file={{null}} @onFileSelected={{onFileSelected}} />
      </template>
    );

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["video"], "clip.mp4", { type: "video/mp4" })
    );

    await triggerEvent(".video-drop-zone", "drop", { dataTransfer });
    await waitUntil(() => selected !== null);

    assert.strictEqual(selected.length, 1, "forwards a single file");
    assert.strictEqual(selected[0].name, "clip.mp4");
  });

  test("forwards only the first file of a multi-file drop", async function (assert) {
    let selected = null;
    const onFileSelected = (files) => {
      selected = files;
    };

    await render(
      <template>
        <VideoDropZone @file={{null}} @onFileSelected={{onFileSelected}} />
      </template>
    );

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["video"], "first.mp4", { type: "video/mp4" })
    );
    dataTransfer.items.add(
      new File(["video"], "second.mp4", { type: "video/mp4" })
    );

    await triggerEvent(".video-drop-zone", "drop", { dataTransfer });
    await waitUntil(() => selected !== null);

    assert.strictEqual(selected.length, 1, "forwards a single file");
    assert.strictEqual(selected[0].name, "first.mp4");
  });

  test("ignores drops and carries the --disabled class while disabled", async function (assert) {
    let called = false;
    const onFileSelected = () => {
      called = true;
    };

    await render(
      <template>
        <VideoDropZone
          @file={{null}}
          @disabled={{true}}
          @onFileSelected={{onFileSelected}}
        />
      </template>
    );

    assert.dom(".video-drop-zone").hasClass("--disabled");

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["video"], "clip.mp4", { type: "video/mp4" })
    );

    await triggerEvent(".video-drop-zone", "drop", { dataTransfer });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.false(called, "@onFileSelected is not called while disabled");
  });

  test("renders a thumbnail with metadata and toggles the player when a preview is produced", async function (assert) {
    stubVideoPreview({ duration: 154, width: 1920, height: 1080 });
    sinon.stub(URL, "createObjectURL").returns("blob:stub");
    sinon.stub(URL, "revokeObjectURL");

    const file = new File(["x".repeat(2048)], "holiday.mp4", {
      type: "video/mp4",
    });
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone @file={{file}} @onFileSelected={{noop}} />
      </template>
    );

    await waitUntil(() =>
      document.querySelector(".video-drop-zone__thumb-img")
    );

    assert
      .dom(".video-drop-zone__thumb")
      .exists("renders the thumbnail button");
    assert
      .dom(".video-drop-zone__thumb-img")
      .exists("renders the poster image");
    assert
      .dom(".video-drop-zone__file-duration")
      .hasText("2:34", "shows the formatted duration");
    assert
      .dom(".video-drop-zone__file-resolution")
      .hasText("1080p", "shows the resolution label");
    assert
      .dom(".video-drop-zone__player")
      .doesNotExist("player is not mounted before the first open");

    await click(".video-drop-zone__thumb");
    assert
      .dom(".video-drop-zone__player")
      .exists("clicking the thumbnail mounts the player");
    assert
      .dom(".video-drop-zone__player-wrap")
      .hasClass("--open", "the player is shown");
    assert
      .dom(".video-drop-zone__player")
      .doesNotHaveAttribute("autoplay", "the player does not autoplay");

    await click(".video-drop-zone__thumb");
    assert
      .dom(".video-drop-zone__player-wrap")
      .doesNotHaveClass("--open", "clicking again hides the player");
  });

  test("falls back to the plain chip when no preview can be produced", async function (assert) {
    // Stub <video> to fire "error" so the extractor resolves null promptly.
    const original = document.createElement.bind(document);
    sinon.stub(document, "createElement").callsFake((tag) => {
      if (tag === "video") {
        const handlers = {};
        return {
          addEventListener: (type, handler) => (handlers[type] = handler),
          set src(_value) {
            setTimeout(() => handlers.error?.(), 0);
          },
        };
      }
      return original(tag);
    });
    sinon.stub(URL, "createObjectURL").returns("blob:stub");
    sinon.stub(URL, "revokeObjectURL");

    const file = new File(["x".repeat(2048)], "holiday.mp4", {
      type: "video/mp4",
    });
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone @file={{file}} @onFileSelected={{noop}} />
      </template>
    );

    await waitUntil(() =>
      document.querySelector(".video-drop-zone__thumb-fallback")
    );

    assert.dom(".video-drop-zone__file-name").hasText("holiday.mp4");
    assert
      .dom(".video-drop-zone__file-size")
      .hasText(I18n.toHumanSize(file.size));
    assert
      .dom(".video-drop-zone__thumb-img")
      .doesNotExist("no poster image when extraction fails");
    assert
      .dom(".video-drop-zone__thumb-fallback")
      .exists("shows the fallback icon instead");
  });

  test("shows a loading skeleton while the preview is being extracted", async function (assert) {
    // <video> that never fires events keeps the extraction pending.
    const original = document.createElement.bind(document);
    sinon.stub(document, "createElement").callsFake((tag) => {
      if (tag === "video") {
        return {
          addEventListener() {},
          set src(_value) {},
          set currentTime(_value) {},
        };
      }
      return original(tag);
    });
    sinon.stub(URL, "createObjectURL").returns("blob:stub");
    sinon.stub(URL, "revokeObjectURL");

    const file = new File(["x".repeat(2048)], "holiday.mp4", {
      type: "video/mp4",
    });
    const noop = () => {};

    await render(
      <template>
        <VideoDropZone @file={{file}} @onFileSelected={{noop}} />
      </template>
    );

    await waitUntil(() =>
      document.querySelector(".video-drop-zone__thumb-skeleton")
    );

    assert
      .dom(".video-drop-zone__thumb-skeleton")
      .exists("shows a skeleton placeholder while extracting");
    assert
      .dom(".video-drop-zone__thumb-img")
      .doesNotExist("no poster image yet");
  });
});
