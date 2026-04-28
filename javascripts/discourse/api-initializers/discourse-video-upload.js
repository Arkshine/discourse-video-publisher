import { setOwner } from "@ember/owner";
import { service } from "@ember/service";
import { withPluginApi } from "discourse/lib/plugin-api";
import VideoUpload from "../components/modal/video-upload";

class VideoUploadInit {
  @service modal;

  constructor(owner, api) {
    setOwner(this, owner);

    if (settings.youtube_upload_enabled || settings.vimeo_upload_enabled) {
      api.onToolbarCreate((toolbar) => {
        toolbar.addButton({
          title: themePrefix("upload.video"),
          id: "video-upload",
          group: "insertions",
          icon: "video",
          perform: () => this.modal.show(VideoUpload),
        });
      });
    }
  }
}

export default {
  name: "discourse-video-upload",

  initialize(owner) {
    // Handle Vimeo OAuth callback
    if (settings.vimeo_oauth_client_id.trim()) {
      const { hash } = window.location;
      if (
        hash.includes("access_token=") &&
        hash.includes("token_type=bearer") &&
        hash.includes("state=")
      ) {
        const params = new URLSearchParams(hash.slice(1));
        const token = params.get("access_token");
        const state = params.get("state");

        if (!token || !state) {
          return;
        }

        document.body.classList.add("vimeo-oauth-callback");

        const channel = new BroadcastChannel(`vimeo-oauth-${state}`);
        channel.postMessage({ type: "vimeo-oauth", token, state });
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
