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
    withPluginApi((api) => {
      this.instance = new VideoUploadInit(owner, api);
    });
  },

  teardown() {
    this.instance = null;
  },
};
