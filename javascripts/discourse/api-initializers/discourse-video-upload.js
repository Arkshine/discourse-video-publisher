import { setOwner } from "@ember/owner";
import { service } from "@ember/service";
import { withPluginApi } from "discourse/lib/plugin-api";
import { i18n } from "discourse-i18n";
import VideoUpload from "../components/modal/video-upload";

class VideoUploadInit {
  @service modal;
  @service currentUser;

  constructor(owner, api) {
    setOwner(this, owner);

    if (
      settings.youtube_upload_enabled ||
      settings.vimeo_upload_enabled ||
      settings.cloudflare_stream_upload_enabled ||
      settings.mux_upload_enabled
    ) {
      api.onToolbarCreate((toolbar) => {
        toolbar.addButton({
          title: themePrefix("upload.video"),
          id: "video-upload",
          group: "insertions",
          icon: "video-upload",
          perform: () => this.modal.show(VideoUpload),
          condition: () => this.userAllowed,
        });
      });
    }
  }

  get userAllowed() {
    const allowed = settings.allowed_groups
      .split("|")
      .filter(Boolean)
      .map(Number);

    if (!allowed.length) {
      return false;
    }

    if (allowed.includes(0)) {
      return true;
    }

    const groups = this.currentUser?.groups ?? [];
    return groups.some((group) => allowed.includes(group.id));
  }
}

export default {
  name: "discourse-video-upload",

  initialize(owner) {
    // Handle video broker (Cloudflare Stream / Mux) auth callback
    if (
      settings.cloudflare_stream_upload_enabled ||
      settings.mux_upload_enabled
    ) {
      const match = window.location.hash.match(/video-broker-code=([^&]+)/);
      if (match) {
        const code = decodeURIComponent(match[1]);

        history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        );

        document.body.classList.add("video-broker-callback");

        const overlay = document.createElement("div");
        overlay.className = "video-broker-callback__overlay";
        overlay.textContent = i18n(themePrefix("video_broker.authenticating"));
        document.body.appendChild(overlay);

        const channel = new BroadcastChannel("discourse-video-broker-auth");
        channel.postMessage({ type: "video-broker-code", code });
        channel.close();

        window.close();
        return;
      }
    }

    // Handle Vimeo OAuth callback
    if (settings.vimeo_oauth_client_id.trim()) {
      const { hash, search } = window.location;
      const raw = hash.startsWith("#") ? hash.slice(1) : search.slice(1);
      const params = new URLSearchParams(raw);
      const state = params.get("state");
      const token = params.get("access_token");
      const error =
        params.get("error") || (state && !token ? "access_denied" : null);

      if (state) {
        document.body.classList.add("vimeo-oauth-callback");

        const overlay = document.createElement("div");
        overlay.className = "vimeo-oauth-callback__overlay";
        overlay.textContent = i18n(themePrefix("vimeo_oauth.authenticating"));
        document.body.appendChild(overlay);

        const channel = new BroadcastChannel(`vimeo-oauth-${state}`);
        channel.postMessage({
          type: "vimeo-oauth",
          state,
          token,
          error,
          errorDescription: params.get("error_description"),
        });

        channel.close();
        window.close();
        return;
      }
    }

    withPluginApi((api) => {
      this.instance = new VideoUploadInit(owner, api);
    });
  },

  teardown() {
    this.instance = null;
  },
};
