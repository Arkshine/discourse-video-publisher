import loadScript from "discourse/lib/load-script";
import { UploadVideoError } from "./util";

const GOOGLE_IDENTITY_SERVICES_URL = "https://accounts.google.com/gsi/client";

const YOUTUBE_UPLOAD_SCOPES = ["https://www.googleapis.com/auth/youtube"];

const GOOGLE_AUTH_POPUP_ERRORS = {
  popup_closed: [
    "errors.google_auth_popup_closed",
    "Google auth was closed before completing.",
  ],
  popup_failed_to_open: [
    "errors.google_auth_popup_failed_to_open",
    "Google auth popup failed to open.",
  ],
};

export async function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) {
    return window.google.accounts.oauth2;
  }

  await loadScript(GOOGLE_IDENTITY_SERVICES_URL);

  if (!window.google?.accounts?.oauth2) {
    throw new UploadVideoError(
      "errors.google_identity_load_failed",
      "Google Identity Services failed to load."
    );
  }

  return window.google.accounts.oauth2;
}

export async function requestYoutubeAccessToken({
  clientId,
  prompt = "consent",
}) {
  if (!clientId) {
    throw new UploadVideoError(
      "errors.youtube_client_id_missing",
      "Missing YouTube API client ID."
    );
  }

  const oauth2 = await loadGoogleIdentityServices();

  return new Promise((resolve, reject) => {
    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: YOUTUBE_UPLOAD_SCOPES.join(" "),
      callback: (response) => {
        if (!response) {
          reject(
            new UploadVideoError(
              "errors.google_auth_no_response",
              "No response from Google auth."
            )
          );
          return;
        }

        if (response.error) {
          const error = new Error(response.error);
          error.details = response;
          reject(error);
          return;
        }

        if (!response.access_token) {
          reject(
            new UploadVideoError(
              "errors.google_auth_access_token_missing",
              "No access token returned by Google."
            )
          );
          return;
        }

        resolve(response.access_token);
      },
      error_callback: ({ type } = {}) => {
        const [translationKey, fallbackMessage] = GOOGLE_AUTH_POPUP_ERRORS[
          type
        ] ?? [
          "errors.google_auth_popup_error",
          "Google auth could not be completed.",
        ];

        reject(new UploadVideoError(translationKey, fallbackMessage));
      },
    });

    tokenClient.requestAccessToken({ prompt });
  });
}
