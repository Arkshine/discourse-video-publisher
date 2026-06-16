import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { next } from "@ember/runloop";
import { service } from "@ember/service";
import Uppy from "@uppy/core";
import DropTarget from "@uppy/drop-target";
import { modifier } from "ember-modifier";
import DButton from "discourse/components/d-button";
import DPickFilesButton from "discourse/ui-kit/d-pick-files-button";
import icon from "discourse/ui-kit/helpers/d-icon";
import I18n, { i18n } from "discourse-i18n";
import {
  extractVideoPreview,
  formatDuration,
  resolutionLabel,
} from "../lib/upload-video/video-preview";

export default class VideoDropZone extends Component {
  @service site;

  @tracked preview = null;
  @tracked loading = false;
  @tracked expanded = false;
  @tracked playbackUrl = null;

  fileInput = null;
  playerEl = null;

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

  loadPreview = modifier((element, [file]) => {
    const key = file ? `${file.name}:${file.size}:${file.lastModified}` : null;

    if (key === this.#fileKey) {
      return;
    }
    this.#fileKey = key;

    next(() => this.#buildPreview(file, key));
  });

  registerPlayer = modifier((element) => {
    this.playerEl = element;
    return () => {
      if (this.playerEl === element) {
        this.playerEl = null;
      }
    };
  });

  #fileKey = null;

  willDestroy() {
    super.willDestroy(...arguments);
    this.#fileKey = null;
    this.#revokePlayback();
  }

  async #buildPreview(file, key) {
    this.#revokePlayback();
    this.expanded = false;
    this.preview = null;

    if (!file) {
      this.loading = false;
      return;
    }

    this.loading = true;
    const result = await extractVideoPreview(file);

    if (key === this.#fileKey) {
      this.preview = result;
      this.loading = false;
    }
  }

  #revokePlayback() {
    if (this.playbackUrl) {
      URL.revokeObjectURL(this.playbackUrl);
      this.playbackUrl = null;
    }
  }

  get humanFileSize() {
    return I18n.toHumanSize(this.args.file.size);
  }

  get formattedDuration() {
    return formatDuration(this.preview?.duration);
  }

  get resolutionLabel() {
    return resolutionLabel(this.preview?.width, this.preview?.height);
  }

  @action
  toggleExpanded() {
    if (!this.playbackUrl) {
      this.playbackUrl = URL.createObjectURL(this.args.file);
    }

    this.expanded = !this.expanded;

    if (!this.expanded) {
      this.playerEl?.pause();
    }
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
      {{this.loadPreview @file}}
      ...attributes
    >
      {{#if @file}}
        <div class="video-drop-zone__preview">
          {{#if this.playbackUrl}}
            <div
              class="video-drop-zone__player-wrap {{if this.expanded '--open'}}"
            >
              <video
                class="video-drop-zone__player"
                controls
                preload="metadata"
                poster={{this.preview.posterUrl}}
                src={{this.playbackUrl}}
                {{this.registerPlayer}}
              ></video>
            </div>
          {{/if}}
          <div class="video-drop-zone__chip">
            <button
              type="button"
              class="video-drop-zone__thumb"
              title={{i18n (themePrefix "upload.toggle_preview")}}
              aria-label={{i18n (themePrefix "upload.toggle_preview")}}
              {{on "click" this.toggleExpanded}}
            >
              {{#if this.preview}}
                <img
                  src={{this.preview.posterUrl}}
                  alt=""
                  class="video-drop-zone__thumb-img"
                />
                <span class="video-drop-zone__thumb-play">
                  {{icon (if this.expanded "pause" "play")}}
                </span>
              {{else if this.loading}}
                <span class="video-drop-zone__thumb-skeleton"></span>
              {{else}}
                <span class="video-drop-zone__thumb-fallback">
                  {{icon "video"}}
                </span>
              {{/if}}
            </button>
            <span class="video-drop-zone__meta">
              <span class="video-drop-zone__file-name">{{@file.name}}</span>
              <span class="video-drop-zone__file-details">
                <span
                  class="video-drop-zone__file-size"
                >{{this.humanFileSize}}</span>
                {{#if this.formattedDuration}}
                  <span class="video-drop-zone__file-duration">
                    {{this.formattedDuration}}
                  </span>
                {{/if}}
                {{#if this.resolutionLabel}}
                  <span class="video-drop-zone__file-resolution">
                    {{this.resolutionLabel}}
                  </span>
                {{/if}}
              </span>
            </span>
            <DButton
              @action={{@onClear}}
              @icon="xmark"
              @disabled={{@disabled}}
              @translatedTitle={{i18n (themePrefix "upload.clear_file")}}
              class="btn-transparent video-drop-zone__clear"
            />
          </div>
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
