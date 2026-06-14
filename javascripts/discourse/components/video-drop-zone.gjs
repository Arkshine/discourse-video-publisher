import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";
import Uppy from "@uppy/core";
import DropTarget from "@uppy/drop-target";
import { modifier } from "ember-modifier";
import DButton from "discourse/components/d-button";
import DPickFilesButton from "discourse/ui-kit/d-pick-files-button";
import icon from "discourse/ui-kit/helpers/d-icon";
import I18n, { i18n } from "discourse-i18n";

export default class VideoDropZone extends Component {
  @service site;

  fileInput = null;

  setupDropTarget = modifier((element) => {
    if (this.site.mobileView) {
      return;
    }

    const uppy = new Uppy({ id: "video-upload-drop-zone", autoProceed: false });
    uppy.use(DropTarget, { target: element });
    uppy.on("files-added", (files) => {
      files.forEach((file) => uppy.removeFile(file.id));

      if (!this.args.disabled && files.length) {
        this.args.onFileSelected([files[0].data]);
      }
    });

    return () => uppy.destroy();
  });

  get humanFileSize() {
    return I18n.toHumanSize(this.args.file.size);
  }

  @action
  registerFileInput(input) {
    this.fileInput = input;
    input.addEventListener("change", this.handleFileInputChange);
  }

  @action
  handleFileInputChange(event) {
    const files = Array.from(event.target.files ?? []);
    // reset so picking the same file again after clearing re-fires "change"
    event.target.value = "";

    if (files.length) {
      this.args.onFileSelected(files);
    }
  }

  @action
  openFilePicker() {
    this.fileInput?.click();
  }

  <template>
    <div
      class="video-drop-zone
        {{if @disabled '--disabled'}}
        {{if this.site.mobileView '--mobile'}}"
      {{this.setupDropTarget}}
      ...attributes
    >
      {{#if @file}}
        <div class="video-drop-zone__chip">
          {{icon "video"}}
          <span class="video-drop-zone__meta">
            <span class="video-drop-zone__file-name">{{@file.name}}</span>
            <span
              class="video-drop-zone__file-size"
            >{{this.humanFileSize}}</span>
          </span>
          <DButton
            @action={{@onClear}}
            @icon="xmark"
            @disabled={{@disabled}}
            @translatedTitle={{i18n (themePrefix "upload.clear_file")}}
            class="btn-transparent video-drop-zone__clear"
          />
        </div>
      {{else}}
        <div class="video-drop-zone__empty">
          {{#unless this.site.mobileView}}
            {{icon "upload"}}
            <span class="video-drop-zone__hint">
              {{i18n (themePrefix "upload.drop_hint")}}
            </span>
          {{/unless}}
          <DButton
            @action={{this.openFilePicker}}
            @disabled={{@disabled}}
            @translatedLabel={{i18n (themePrefix "upload.browse")}}
            class="btn-default video-drop-zone__browse"
          />
          <DPickFilesButton
            @fileInputId={{@inputId}}
            @fileInputDisabled={{@disabled}}
            @acceptedFormatsOverride="video/mp4,video/x-m4v,video/*"
            @allowMultiple={{false}}
            @registerFileInput={{this.registerFileInput}}
          />
        </div>
      {{/if}}
    </div>
  </template>
}
