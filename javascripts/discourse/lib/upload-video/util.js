import { i18n } from "discourse-i18n";

export class UploadVideoError extends Error {
  constructor(translationKey, fallbackMessage, options = {}) {
    super(fallbackMessage);

    this.name = "UploadVideoError";
    this.translationKey = translationKey;
    this.interpolationValues = options.interpolationValues ?? {};
    this.details = options.details;
    this.cleanup = options.cleanup ?? false;
  }
}

export function uploadErrorMessage(errorData) {
  let data = errorData;

  if (data instanceof UploadVideoError) {
    return i18n(themePrefix(data.translationKey), data.interpolationValues);
  }

  if (data instanceof Error) {
    data = data.message;
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      const invalidPrivacyView = parsed.invalid_parameters?.find(
        (p) => p.field === "privacy.view" && p.error_code === 2410
      );

      if (invalidPrivacyView) {
        return i18n(themePrefix("errors.vimeo_privacy_view_unavailable"));
      }

      data = parsed;
    } catch {
      return data;
    }
  }

  return data?.error?.message ?? data?.error ?? data?.message ?? data;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CancelledError extends Error {
  constructor() {
    super("Upload cancelled by user.");
    this.cancelled = true;
  }
}
