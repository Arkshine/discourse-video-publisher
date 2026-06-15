import { click, render, triggerEvent, waitUntil } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "discourse/tests/helpers/component-test";
import I18n, { i18n } from "discourse-i18n";
import VideoDropZone from "../../discourse/components/video-drop-zone";

module("Unit | Component | video-drop-zone", function (hooks) {
  setupRenderingTest(hooks);

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
});
