import Component from "@glimmer/component";
import { cached, tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { action, getProperties } from "@ember/object";
import { service } from "@ember/service";
import DButton from "discourse/components/d-button";
import DModal from "discourse/components/d-modal";
import Form from "discourse/components/form";
import icon from "discourse/helpers/d-icon";
import { eq } from "discourse/truth-helpers";
import { i18n } from "discourse-i18n";
import { requestYoutubeAccessToken } from "../../lib/upload-video/google-auth";
import { clearVimeoToken, requestVimeoAccessToken } from "../../lib/upload-video/vimeo-auth";
import {
  buildVimeoMetadata,
  buildYoutubeMetadata,
  buildYoutubeMetadataParts,
} from "../../lib/upload-video/metadata";
import VimeoUploadClient from "../../lib/upload-video/provider/vimeo";
import YouTubeUploadClient from "../../lib/upload-video/provider/youtube";
import { CancelledError, uploadErrorMessage } from "../../lib/upload-video/util";

const STATUS_POLLING_INTERVAL_MILLIS = 10000;

const FORM_FIELDS = [
  "title",
  "description",
  "privacy",
  "provider",
  "video",
  "vimeoEmbedPrivacy",
  "vimeoViewPrivacy",
];

export default class VideoUpload extends Component {
  @service appEvents;
  @service currentUser;
  @service dialog;

  @tracked uploadProgress = 0;
  @tracked isAuthing = false;
  @tracked isUploading = false;
  @tracked isProcessing = false;
  @tracked isPaused = false;
  @tracked uploadError = null;
  @tracked isCancelling = false;
  @tracked selectedProvider = this.defaultProvider;

  uploader = null;
  cancelRequested = false;

  privacy = settings.youtube_default_view_privacy;
  provider = this.defaultProvider;
  vimeoEmbedPrivacy = settings.vimeo_default_embed_privacy;
  vimeoViewPrivacy = settings.vimeo_default_view_privacy;

  @cached
  get formData() {
    return getProperties(this, ...FORM_FIELDS);
  }

  get hasStatus() {
    return (
      this.isAuthing ||
      this.isUploading ||
      this.isProcessing ||
      this.isPaused ||
      this.isCancelling ||
      this.uploadError
    );
  }

  get vimeoEnabled() {
    return settings.vimeo_upload_enabled;
  }

  get youtubeEnabled() {
    return settings.youtube_upload_enabled;
  }

  get defaultProvider() {
    if (this.youtubeEnabled && !this.vimeoEnabled) {
      return "youtube";
    }

    if (this.vimeoEnabled && !this.youtubeEnabled) {
      return "vimeo";
    }

    return null;
  }

  get providerSelectionEnabled() {
    return this.youtubeEnabled && this.vimeoEnabled;
  }

  @action
  registerApi(api) {
    this.formApi = api;
  }

  @action
  async changeProvider(setProvider, provider) {
    this.uploadError = null;
    this.formApi?.removeError("provider");
    this.formApi?.removeError("privacy");

    await setProvider(provider);
  }

  @action
  handleProviderChange(setProvider, value) {
    setProvider(value);
    this.selectedProvider = value;
  }

  @action
  validateVideoFile(event) {
    const input = event.target;
    const file = input.files[0];

    if (!file) {
      this.formApi.set("video", null);
      return false;
    }

    if (!file.type.startsWith("video/")) {
      this.formApi.set("video", null);

      if (input) {
        input.value = "";
      }

      this.formApi.addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.invalid")),
      });
      return false;
    }

    this.formApi.removeError("title");
    this.formApi.removeError("video");

    this.formApi.set("title", file.name);
    this.formApi.set("video", file);
    return true;
  }

  @action
  validateUpload(data, { addError }) {
    if (!data.video) {
      addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.required")),
      });
    }

    if (data.video && !data.video.type.startsWith("video/")) {
      addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.invalid")),
      });
    }

    if (!data.title) {
      addError("title", {
        title: i18n(themePrefix("details.title")),
        message: i18n(themePrefix("validation.title.required")),
      });
    }

    if (!data.provider) {
      addError("provider", {
        title: i18n(themePrefix("provider.title")),
        message: i18n(themePrefix("validation.provider.required")),
      });
    }

    if (data.provider === "youtube" && !data.privacy) {
      addError("privacy", {
        title: i18n(themePrefix("details.privacy")),
        message: i18n(themePrefix("validation.privacy.required")),
      });
    }
  }

  get uploadDisabled() {
    return this.isUploading || this.isProcessing || this.isAuthing;
  }

  get isModalDismissable() {
    return !this.uploadDisabled || this.isPaused;
  }

  updateProgress(data) {
    const progress = Math.floor((data.loaded / data.total) * 100);
    this.uploadProgress = progress;
  }

  startUpload() {
    this.uploadProgress = 0;
    this.isAuthing = false;
    this.isUploading = true;
    this.isProcessing = false;
    this.isPaused = false;
    this.uploadError = null;
  }

  startProcessing() {
    this.uploadProgress = 0;
    this.isUploading = false;
    this.isProcessing = true;
  }

  finishProcessing() {
    this.isProcessing = false;
  }

  failUpload(error) {
    this.uploadProgress = 0;
    this.isAuthing = false;
    this.isUploading = false;
    this.isProcessing = false;
    this.uploadError = uploadErrorMessage(error);
  }

  resetUpload() {
    this.uploadProgress = 0;
    this.isAuthing = false;
    this.isUploading = false;
    this.isProcessing = false;
    this.isPaused = false;
    this.isCancelling = false;
    this.uploadError = null;
    this.cancelRequested = false;
    this.uploader = null;
  }

  @action
  pauseUpload() {
    this.isPaused = true;
    this.uploader?.pause();
  }

  @action
  resumeUpload() {
    this.isPaused = false;
    this.uploader?.unpause();
  }

  @action
  async cancelUpload() {
    if (this.isCancelling) {
      return;
    }

    const confirmed = await this.dialog.yesNoConfirm({
      message: i18n(themePrefix("upload.cancel-confirm")),
    });

    if (!confirmed) {
      return;
    }

    this.isCancelling = true;
    this.cancelRequested = true;
  }

  @action
  submitUpload() {
    this.formApi?.submit();
  }

  @action
  async handleSubmit(data) {
    switch (data.provider) {
      case "vimeo":
        await this.vimeoUpload(data);
        break;
      case "youtube":
        await this.youtubeUpload(data);
        break;
    }
  }

  @action
  async youtubeUpload(data) {
    try {
      this.isAuthing = true;
      this.uploadError = null;

      const accessToken = await requestYoutubeAccessToken({
        clientId: settings.youtube_api_client_id,
      });

      this.startUpload();

      const metadata = buildYoutubeMetadata(data);

      const uploader = new YouTubeUploadClient({
        file: data.video,
        token: accessToken,
        metadata,
        params: {
          part: buildYoutubeMetadataParts(metadata),
        },
        onProgress: (progressData) => {
          this.updateProgress(progressData);
        },
      });

      this.uploader = uploader;
      await uploader.upload();

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      this.startProcessing();

      const video = await uploader.waitForYoutubeProcessing(accessToken, {
        shouldCancel: () => this.cancelRequested,
      });

      this.finishProcessing();

      this.appEvents.trigger(
        "composer:insert-block",
        `\nhttps://youtube.com/watch?v=${video.id}\n`
      );
      this.closeUploadModal();
    } catch (error) {
      if (error?.cancelled) {
        try {
          await this.uploader?.deleteVideo();
        } catch (_) {
          // ignore delete failure, still reset
        }
        this.resetUpload();
        return;
      }
      this.failUpload(error);
    } finally {
      this.isAuthing = false;
    }
  }

  @action
  async vimeoUpload(data) {
    let token;

    if (settings.vimeo_oauth_client_id) {
      try {
        this.isAuthing = true;
        this.uploadError = null;
        token = await requestVimeoAccessToken({
          clientId: settings.vimeo_oauth_client_id,
          userId: this.currentUser.id,
        });
      } catch (error) {
        this.failUpload(error);
        return;
      } finally {
        this.isAuthing = false;
      }
    } else {
      token = settings.vimeo_api_access_token;
    }

    this.startUpload();

    const uploadInst = new VimeoUploadClient({
      file: data.video,
      token,
      metadata: buildVimeoMetadata(data, {
        username: this.currentUser.username,
        viewPrivacy: this.vimeoViewPrivacy,
        embedPrivacy: this.vimeoEmbedPrivacy,
      }),
      onProgress: (progressData) => this.updateProgress(progressData),
    });

    this.uploader = uploadInst;

    try {
      const videoUri = await uploadInst.upload();

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      const videoId = videoUri.split("/").pop();
      const uploadUrl = uploadInst.videoLink ?? `https://vimeo.com/${videoId}`;

      this.startProcessing();

      await uploadInst.waitForTranscode({
        interval: STATUS_POLLING_INTERVAL_MILLIS,
        shouldCancel: () => this.cancelRequested,
      });

      this.finishProcessing();

      this.appEvents.trigger("composer:insert-block", `\n${uploadUrl}\n`);
      this.closeUploadModal();
    } catch (error) {
      if (error?.cancelled) {
        try {
          await uploadInst.deleteVideo();
        } catch (_) {
          // ignore delete failure, still reset
        }
        this.resetUpload();
        return;
      }
      if (error?.status === 401 && settings.vimeo_oauth_client_id) {
        clearVimeoToken(this.currentUser.id);
      }
      this.failUpload(error);
    }
  }

  @action
  closeUploadModal() {
    this.args?.closeModal();
  }

  <template>
    <DModal
      @title={{i18n (themePrefix "upload.video")}}
      @closeModal={{this.closeUploadModal}}
      @dismissable={{this.isModalDismissable}}
      class="video-upload-modal"
    >
      <:body>
        <Form
          @data={{this.formData}}
          @onSubmit={{this.handleSubmit}}
          @validate={{this.validateUpload}}
          @onRegisterApi={{this.registerApi}}
          as |form|
        >
          <form.Section>
            {{#if this.providerSelectionEnabled}}
              <form.Field
                @name="provider"
                @title={{i18n (themePrefix "provider.title")}}
                @type="custom"
                @format="full"
                @showTitle={{false}}
                as |field|
              >
                <field.Control>
                  <form.Container
                    @title={{i18n (themePrefix "provider.title")}}
                    @format="full"
                    @class="--radio-cards"
                  >
                    <form.ConditionalContent
                      @activeName={{field.value}}
                      @onChange={{fn this.handleProviderChange field.set}}
                      as |conditional|
                    >
                      <conditional.Conditions as |Condition|>
                        <Condition
                          @name="youtube"
                          @disabled={{this.uploadDisabled}}
                        >
                          {{icon "check"}}
                          {{i18n (themePrefix "provider.youtube")}}
                        </Condition>

                        <Condition
                          @name="vimeo"
                          @disabled={{this.uploadDisabled}}
                        >
                          {{icon "check"}}
                          {{i18n (themePrefix "provider.vimeo")}}
                        </Condition>
                      </conditional.Conditions>
                    </form.ConditionalContent>
                  </form.Container>
                </field.Control>
              </form.Field>
            {{/if}}

            <form.Field
              @name="video"
              @title={{i18n (themePrefix "upload.video")}}
              @type="custom"
              @format="full"
              @validation="required"
              as |field|
            >
              <field.Control>
                <input
                  type="file"
                  id={{field.id}}
                  accept="video/mp4,video/x-m4v,video/*"
                  disabled={{this.uploadDisabled}}
                  onchange={{this.validateVideoFile}}
                />
              </field.Control>
            </form.Field>

            <form.Field
              @name="title"
              @title={{i18n (themePrefix "details.title")}}
              @validation="required"
              @type="input"
              @format="full"
              as |field|
            >
              <field.Control
                id="video-title"
                disabled={{this.uploadDisabled}}
                placeholder={{i18n (themePrefix "details.title")}}
              />
            </form.Field>

            <form.Field
              @name="description"
              @title={{i18n (themePrefix "details.description")}}
              @type="input"
              @format="full"
              as |field|
            >
              <field.Control
                id="video-description"
                disabled={{this.uploadDisabled}}
                placeholder={{i18n (themePrefix "details.description")}}
              />
            </form.Field>

            <form.ConditionalContent
              @activeName={{this.selectedProvider}}
              as |conditional|
            >
              <conditional.Contents as |Content|>
                <Content @name="youtube">
                  <form.Section
                    @title={{i18n (themePrefix "provider.youtube-settings")}}
                  >
                    <form.Field
                      @name="privacy"
                      @title={{i18n (themePrefix "details.privacy")}}
                      @validation="required"
                      @type="select"
                      as |field|
                    >
                      <field.Control id="video-scope" as |select|>
                        <select.Option @value="unlisted">
                          {{i18n (themePrefix "details.scope.unlisted")}}
                        </select.Option>
                        <select.Option @value="public">
                          {{i18n (themePrefix "details.scope.public")}}
                        </select.Option>
                        <select.Option @value="private">
                          {{i18n (themePrefix "details.scope.private")}}
                        </select.Option>
                      </field.Control>
                    </form.Field>
                  </form.Section>
                </Content>

                <Content @name="vimeo">
                  <form.Section
                    @title={{i18n (themePrefix "provider.vimeo-settings")}}
                  >
                    <form.Field
                      @name="vimeoViewPrivacy"
                      @title={{i18n (themePrefix "details.vimeo-view-privacy")}}
                      @helpText={{i18n
                        (themePrefix "details.vimeo-view-privacy-help")
                      }}
                      @validation="required"
                      @type="select"
                      as |field|
                    >
                      <field.Control id="vimeo-view-privacy" as |select|>
                        <select.Option @value="anybody">
                          {{i18n (themePrefix "details.vimeo-view.anybody")}}
                        </select.Option>
                        <select.Option @value="unlisted">
                          {{i18n (themePrefix "details.vimeo-view.unlisted")}}
                        </select.Option>
                        <select.Option @value="disable">
                          {{i18n (themePrefix "details.vimeo-view.disable")}}
                        </select.Option>
                      </field.Control>
                    </form.Field>

                    <form.Field
                      @name="vimeoEmbedPrivacy"
                      @title={{i18n
                        (themePrefix "details.vimeo-embed-privacy")
                      }}
                      @validation="required"
                      @type="select"
                      as |field|
                    >
                      <field.Control id="vimeo-embed-privacy" as |select|>
                        <select.Option @value="public">
                          {{i18n (themePrefix "details.vimeo-embed.public")}}
                        </select.Option>
                        <select.Option @value="private">
                          {{i18n (themePrefix "details.vimeo-embed.private")}}
                        </select.Option>
                      </field.Control>
                    </form.Field>
                  </form.Section>
                </Content>
              </conditional.Contents>
            </form.ConditionalContent>
          </form.Section>
        </Form>
      </:body>

      <:footer>
        <DButton
          @action={{this.submitUpload}}
          @id="video-upload-btn"
          class="btn-primary"
          @icon={{if
            (eq this.selectedProvider "youtube")
            "fab-youtube"
            (if (eq this.selectedProvider "vimeo") "fab-vimeo-v" "video")
          }}
          @disabled={{this.uploadDisabled}}
          @translatedLabel={{if
            (eq this.selectedProvider "youtube")
            (i18n (themePrefix "upload.youtube"))
            (if
              (eq this.selectedProvider "vimeo")
              (i18n (themePrefix "upload.vimeo"))
              (i18n (themePrefix "upload.choose-provider"))
            )
          }}
        />

        {{#if this.hasStatus}}
          <div class="video-upload-status">
            {{#if this.isCancelling}}
              <div class="video-upload-status-line">
                <span>{{i18n (themePrefix "status.cancelling")}}</span>
                <div class="spinner"></div>
              </div>
            {{else}}
              {{#if this.isAuthing}}
                <div class="video-upload-status-line">
                  <span>{{i18n (themePrefix "status.authenticating")}}</span>
                  <div class="spinner"></div>
                </div>
              {{/if}}

              {{#if this.isUploading}}
                <div class="video-upload-status-line">
                  <span>
                    {{#if this.isPaused}}
                      {{i18n (themePrefix "status.paused")}}
                    {{else}}
                      {{i18n (themePrefix "status.uploading")}}
                    {{/if}}
                    {{this.uploadProgress}}%
                  </span>
                  <div class="video-upload-controls">
                    {{#if this.isPaused}}
                      <DButton
                        @action={{this.resumeUpload}}
                        @icon="play"
                        class="btn-flat"
                        @translatedLabel={{i18n (themePrefix "upload.resume")}}
                      />
                    {{else}}
                      <DButton
                        @action={{this.pauseUpload}}
                        @icon="pause"
                        class="btn-flat"
                        @translatedLabel={{i18n (themePrefix "upload.pause")}}
                      />
                    {{/if}}
                    <DButton
                      @action={{this.cancelUpload}}
                      @icon="xmark"
                      class="btn-flat"
                      @translatedLabel={{i18n (themePrefix "upload.cancel")}}
                    />
                  </div>
                </div>
              {{/if}}

              {{#if this.isProcessing}}
                <div class="video-upload-status-line">
                  <span>{{i18n (themePrefix "status.transcoding")}}</span>
                  <div class="spinner"></div>
                  <div class="video-upload-controls">
                    <DButton
                      @action={{this.cancelUpload}}
                      @icon="xmark"
                      class="btn-flat"
                      @translatedLabel={{i18n (themePrefix "upload.cancel")}}
                    />
                  </div>
                </div>
              {{/if}}

              {{#if this.uploadError}}
                <div class="video-upload-status-line video-upload-error">
                  <span>{{i18n (themePrefix "status.error.upload")}}:
                    {{this.uploadError}}</span>
                </div>
              {{/if}}
            {{/if}}
          </div>
        {{/if}}
      </:footer>
    </DModal>
  </template>
}
