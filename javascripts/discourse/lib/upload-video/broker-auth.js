import { CancelledError, UploadVideoError } from "./util";

const CHANNEL_NAME = "discourse-video-broker-auth";
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const CANCEL_POLL_MS = 500;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

let cached = null; // { token, expiresAt }

export function clearBrokerToken() {
  cached = null;
}

export async function requestBrokerToken({ brokerOrigin, shouldCancel } = {}) {
  const origin = (brokerOrigin || "").trim().replace(/\/$/, "");

  if (!origin) {
    throw new UploadVideoError(
      "errors.broker_origin_missing",
      "Missing video broker origin."
    );
  }

  if (cached && cached.expiresAt - Date.now() > TOKEN_EXPIRY_MARGIN_MS) {
    return cached.token;
  }

  const code = await requestBrokerCode({ origin, shouldCancel });
  return await exchangeCode({ origin, code });
}

function requestBrokerCode({ origin, shouldCancel }) {
  const width = 600;
  const height = 700;
  const left = Math.round((window.screen.width - width) / 2);
  const top = Math.round((window.screen.height - height) / 2);

  const popup = window.open(
    `${origin}/auth/start`,
    "discourse-video-broker-auth",
    `width=${width},height=${height},left=${left},top=${top},toolbar=0,menubar=0,location=0`
  );

  if (!popup) {
    throw new UploadVideoError(
      "errors.broker_auth_popup_blocked",
      "Broker auth popup was blocked. Allow popups for this site and try again."
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const channel = new BroadcastChannel(CHANNEL_NAME);

    function cleanup() {
      clearTimeout(timeoutId);
      clearInterval(cancelPoll);
      channel.close();
      if (!popup.closed) {
        popup.close();
      }
    }

    function settle(fn) {
      if (!settled) {
        settled = true;
        cleanup();
        fn();
      }
    }

    const timeoutId = setTimeout(() => {
      settle(() =>
        reject(
          new UploadVideoError(
            "errors.broker_auth_timeout",
            "Broker auth timed out. Please try again."
          )
        )
      );
    }, POPUP_TIMEOUT_MS);

    // COOP severs the opener reference, so popup.closed is unreliable; poll the
    // caller's cancel signal instead (same approach as vimeo-auth.js).
    const cancelPoll = setInterval(() => {
      if (shouldCancel?.()) {
        settle(() => reject(new CancelledError()));
      }
    }, CANCEL_POLL_MS);

    channel.onmessage = (event) => {
      if (!event.data || event.data.type !== "video-broker-code") {
        return;
      }

      if (!event.data.code) {
        settle(() =>
          reject(
            new UploadVideoError(
              "errors.broker_auth_no_code",
              "No authorization code returned by the broker."
            )
          )
        );
        return;
      }

      settle(() => resolve(event.data.code));
    };
  });
}

async function exchangeCode({ origin, code }) {
  let response;
  try {
    response = await fetch(`${origin}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new UploadVideoError(
      "errors.broker_auth_exchange_failed",
      "Could not reach the broker to exchange the code."
    );
  }

  if (!response.ok) {
    throw new UploadVideoError(
      "errors.broker_auth_exchange_failed",
      "Broker rejected the authorization code."
    );
  }

  const data = await response.json();

  if (!data?.token) {
    throw new UploadVideoError(
      "errors.broker_auth_no_token",
      "No access token returned by the broker."
    );
  }

  const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
  cached = { token: data.token, expiresAt: Date.now() + expiresInMs };

  return data.token;
}
