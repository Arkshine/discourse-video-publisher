import { setupTest } from "ember-qunit";
import { module, test } from "qunit";
import sinon from "sinon";
import {
  clearBrokerToken,
  requestBrokerToken,
} from "../../discourse/lib/upload-video/broker-auth";

module("Unit | Lib | upload-video/broker-auth", function (hooks) {
  setupTest(hooks);

  hooks.afterEach(function () {
    sinon.restore();
    clearBrokerToken();
  });

  test("throws when the broker origin is missing", async function (assert) {
    try {
      await requestBrokerToken({ brokerOrigin: "" });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.strictEqual(error.translationKey, "errors.broker_origin_missing");
    }
  });

  test("throws when the popup is blocked", async function (assert) {
    sinon.stub(window, "open").returns(null);

    try {
      await requestBrokerToken({ brokerOrigin: "https://broker.test" });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.strictEqual(
        error.translationKey,
        "errors.broker_auth_popup_blocked"
      );
    }
  });

  test("rejects with a cancelled error when shouldCancel returns true", async function (assert) {
    const popup = { closed: false, close: sinon.stub() };
    sinon.stub(window, "open").returns(popup);

    try {
      await requestBrokerToken({
        brokerOrigin: "https://broker.test",
        shouldCancel: () => true,
      });
      assert.true(false, "expected an error");
    } catch (error) {
      assert.true(error.cancelled, "rejects with a cancelled error");
    }

    assert.true(popup.close.calledOnce, "closes the popup on cancel");
  });

  test("exchanges the broker code for a token", async function (assert) {
    const popup = { closed: false, close: sinon.stub() };
    sinon.stub(window, "open").returns(popup);
    sinon.stub(window, "fetch").resolves({
      ok: true,
      json: async () => ({ token: "broker-token", expires_in: 3600 }),
    });

    const promise = requestBrokerToken({ brokerOrigin: "https://broker.test" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const channel = new BroadcastChannel("discourse-video-broker-auth");
    channel.postMessage({ type: "video-broker-code", code: "abc" });
    channel.close();

    assert.strictEqual(
      await promise,
      "broker-token",
      "resolves with the token"
    );
  });

  test("caches the token across calls", async function (assert) {
    const open = sinon.stub(window, "open").returns({ close: () => {} });
    sinon.stub(window, "fetch").resolves({
      ok: true,
      json: async () => ({ token: "cached", expires_in: 3600 }),
    });

    const first = requestBrokerToken({ brokerOrigin: "https://broker.test" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const channel = new BroadcastChannel("discourse-video-broker-auth");
    channel.postMessage({ type: "video-broker-code", code: "abc" });
    channel.close();
    await first;

    const second = await requestBrokerToken({
      brokerOrigin: "https://broker.test",
    });

    assert.strictEqual(second, "cached", "returns the cached token");
    assert.strictEqual(open.callCount, 1, "does not reopen the popup");
  });
});
