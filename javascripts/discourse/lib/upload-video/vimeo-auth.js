import { UploadVideoError } from "./util";

const VIMEO_AUTH_URL = "https://api.vimeo.com/oauth/authorize";
const VIMEO_SCOPES = "upload edit delete";
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSED_GRACE_MS = 2000;

function storageKey(userId) {
  return `vimeo_oauth_token_${userId}`;
}

export function getCachedVimeoToken(userId) {
  try {
    return localStorage.getItem(storageKey(userId)) ?? null;
  } catch {
    return null;
  }
}

export function clearVimeoToken(userId) {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // localStorage unavailable in some privacy modes
  }
}

function setCachedVimeoToken(userId, token) {
  try {
    localStorage.setItem(storageKey(userId), token);
  } catch {
    // ignore
  }
}

export async function requestVimeoAccessToken({
  clientId,
  userId,
  forceAuth = false,
}) {
  if (!clientId) {
    throw new UploadVideoError(
      "errors.vimeo_oauth_client_id_missing",
      "Missing Vimeo OAuth client ID."
    );
  }

  if (!forceAuth) {
    const cached = getCachedVimeoToken(userId);
    if (cached) {
      return cached;
    }
  }

  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const params = new URLSearchParams({
    response_type: "token",
    client_id: clientId,
    redirect_uri: window.location.origin,
    scope: VIMEO_SCOPES,
    state,
  });

  const width = 600;
  const height = 700;
  const left = Math.round((window.screen.width - width) / 2);
  const top = Math.round((window.screen.height - height) / 2);

  const popup = window.open(
    `${VIMEO_AUTH_URL}?${params}`,
    "vimeo-oauth",
    `width=${width},height=${height},left=${left},top=${top},toolbar=0,menubar=0,location=0`
  );

  if (!popup) {
    throw new UploadVideoError(
      "errors.vimeo_auth_popup_blocked",
      "Vimeo auth popup was blocked. Allow popups for this site and try again."
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const channel = new BroadcastChannel(`vimeo-oauth-${state}`);

    function cleanup() {
      clearTimeout(timeoutId);
      clearInterval(closedPoll);
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
            "errors.vimeo_auth_timeout",
            "Vimeo auth timed out. Please try again."
          )
        )
      );
    }, POPUP_TIMEOUT_MS);

    // Detect manual close
    let closedAt = null;
    const closedPoll = setInterval(() => {
      if (!popup.closed) {
        return;
      }
      if (closedAt === null) {
        closedAt = Date.now();
      } else if (Date.now() - closedAt >= CLOSED_GRACE_MS) {
        settle(() =>
          reject(
            new UploadVideoError(
              "errors.vimeo_auth_popup_closed",
              "Vimeo auth was closed before completing."
            )
          )
        );
      }
    }, 500);

    channel.onmessage = (event) => {
      if (!event.data || event.data.type !== "vimeo-oauth") {
        return;
      }

      if (event.data.state !== state) {
        settle(() =>
          reject(
            new UploadVideoError(
              "errors.vimeo_auth_state_mismatch",
              "Vimeo auth response did not match the request."
            )
          )
        );
        return;
      }

      if (event.data.error) {
        settle(() =>
          reject(
            new UploadVideoError(
              "errors.vimeo_auth_denied",
              event.data.errorDescription || "Vimeo authorization was denied."
            )
          )
        );
        return;
      }

      if (!event.data.token) {
        settle(() =>
          reject(
            new UploadVideoError(
              "errors.vimeo_auth_no_token",
              "No access token returned by Vimeo."
            )
          )
        );
        return;
      }

      settle(() => {
        setCachedVimeoToken(userId, event.data.token);
        resolve(event.data.token);
      });
    };
  });
}
