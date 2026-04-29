import { setOwner } from "@ember/owner";
import { service } from "@ember/service";
import { withPluginApi } from "discourse/lib/plugin-api";
import VideoUpload from "../components/modal/video-upload";

class VideoUploadInit {
  @service modal;
  @service currentUser;

  constructor(owner, api) {
    setOwner(this, owner);

    if (settings.youtube_upload_enabled || settings.vimeo_upload_enabled) {
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

    const groups = this.currentUser?.groups ?? [];
    return groups.some(
      (group) => allowed.includes(0) || allowed.includes(group.id)
    );
  }
}

export default {
  name: "discourse-video-upload",

  initialize(owner) {
    // Handle Vimeo OAuth callback
    if (settings.vimeo_oauth_client_id.trim()) {
      const { hash, search } = window.location;
      const raw = hash.startsWith("#") ? hash.slice(1) : search.slice(1);
      const params = new URLSearchParams(raw);
      const state = params.get("state");
      const token = params.get("access_token");
      const error = params.get("error") || (state && !token ? "access_denied" : null);

      if (state) {
        document.body.classList.add("vimeo-oauth-callback");

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
