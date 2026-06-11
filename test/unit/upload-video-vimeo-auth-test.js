import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import sinon from "sinon";
import { requestVimeoAccessToken } from "../../discourse/lib/upload-video/vimeo-auth";

module("Unit | Lib | upload-video/vimeo-auth", function (hooks) {
  setupTest(hooks);

  hooks.afterEach(function () {
    sinon.restore();
  });

  test("throws when the OAuth client ID is missing", async function (assert) {
    try {
      await requestVimeoAccessToken({ clientId: "", userId: 1 });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.strictEqual(error.key, "errors.vimeo_oauth_client_id_missing");
    }
  });

  test("throws when the popup is blocked", async function (assert) {
    sinon.stub(window, "open").returns(null);

    try {
      await requestVimeoAccessToken({ clientId: "abc", userId: 2 });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.strictEqual(error.key, "errors.vimeo_auth_popup_blocked");
    }
  });

  test("rejects with a cancelled error when shouldCancel returns true", async function (assert) {
    const popup = { closed: false, close: sinon.stub() };
    sinon.stub(window, "open").returns(popup);

    try {
      await requestVimeoAccessToken({
        clientId: "abc",
        userId: 3,
        shouldCancel: () => true,
      });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.true(error.cancelled, "rejects with a cancelled error");
    }

    assert.true(popup.close.calledOnce, "closes the popup on cancel");
  });

  test("does not reject when the popup reports closed (COOP severs the opener)", async function (assert) {
    // Vimeo's login page sets Cross-Origin-Opener-Policy, so popup.closed is
    // true while the window is still open. Auth must keep waiting for the
    // BroadcastChannel message instead of rejecting.
    const popup = { closed: true, close: sinon.stub() };
    sinon.stub(window, "open").returns(popup);

    const openCall = window.open;
    const promise = requestVimeoAccessToken({ clientId: "abc", userId: 4 });

    // Recover the state param from the opened URL to answer on the channel.
    const url = new URL(openCall.firstCall.args[0]);
    const state = url.searchParams.get("state");

    // Wait past the old 2s closed-grace window before delivering the token.
    await new Promise((resolve) => setTimeout(resolve, 2600));

    const channel = new BroadcastChannel(`vimeo-oauth-${state}`);
    channel.postMessage({ type: "vimeo-oauth", state, token: "tok-123" });
    channel.close();

    assert.strictEqual(
      await promise,
      "tok-123",
      "resolves with the token even though popup.closed was true"
    );
  });
});
