import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import {
  buildVimeoMetadata,
  buildYoutubeMetadata,
  buildYoutubeMetadataParts,
} from "../../discourse/lib/upload-video/metadata";

module("Unit | Lib | upload-video/metadata", function (hooks) {
  setupTest(hooks);

  test("buildYoutubeMetadata shapes snippet and status", function (assert) {
    assert.deepEqual(
      buildYoutubeMetadata({
        title: "My video",
        description: "A description",
        privacy: "unlisted",
      }),
      {
        snippet: { title: "My video", description: "A description" },
        status: { privacyStatus: "unlisted" },
      },
      "maps form data to the YouTube payload"
    );
  });

  test("buildYoutubeMetadataParts joins top-level keys", function (assert) {
    const metadata = buildYoutubeMetadata({
      title: "t",
      description: "d",
      privacy: "public",
    });

    assert.strictEqual(
      buildYoutubeMetadataParts(metadata),
      "snippet,status",
      "produces the part parameter"
    );
  });

  test("buildVimeoMetadata appends attribution to the description", function (assert) {
    const metadata = buildVimeoMetadata(
      {
        title: "My video",
        description: "A description",
        vimeoViewPrivacy: "unlisted",
        vimeoEmbedPrivacy: "private",
      },
      { username: "sam", viewPrivacy: "anybody", embedPrivacy: "public" }
    );

    assert.deepEqual(
      metadata,
      {
        name: "My video",
        description: "A description\nby @sam",
        privacy: { view: "unlisted", embed: "private" },
      },
      "uses form values over defaults and credits the uploader"
    );
  });

  test("buildVimeoMetadata omits the description line when empty", function (assert) {
    const metadata = buildVimeoMetadata(
      { title: "My video" },
      { username: "sam", viewPrivacy: "anybody", embedPrivacy: "public" }
    );

    assert.strictEqual(
      metadata.description,
      "by @sam",
      "does not render a literal undefined description"
    );
    assert.deepEqual(
      metadata.privacy,
      { view: "anybody", embed: "public" },
      "falls back to the default privacy settings"
    );
  });
});
