import Component from "@glimmer/component";
import { cached, tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { action } from "@ember/object";
import { service } from "@ember/service";
import { htmlSafe } from "@ember/template";
import DButton from "discourse/components/d-button";
import DModal from "discourse/components/d-modal";
import Form from "discourse/components/form";
import { eq } from "discourse/truth-helpers";
import icon from "discourse/ui-kit/helpers/d-icon";
import { i18n } from "discourse-i18n";
import {
  clearYoutubeToken,
  requestYoutubeAccessToken,
} from "../../lib/upload-video/google-auth";
import {
  clearBrokerToken,
  requestBrokerToken,
} from "../../lib/upload-video/broker-auth";
import {
  buildCloudflareStreamMetadata,
  buildMuxMetadata,
  buildVimeoMetadata,
  buildYoutubeMetadata,
  buildYoutubeMetadataParts,
} from "../../lib/upload-video/metadata";
import CloudflareStreamUploadClient from "../../lib/upload-video/provider/cloudflare-stream";
import MuxUploadClient from "../../lib/upload-video/provider/mux";
import VimeoUploadClient from "../../lib/upload-video/provider/vimeo";
import YouTubeUploadClient from "../../lib/upload-video/provider/youtube";
import {
  CancelledError,
  uploadErrorMessage,
} from "../../lib/upload-video/util";
import {
  clearVimeoToken,
  requestVimeoAccessToken,
} from "../../lib/upload-video/vimeo-auth";
import VideoDropZone from "../video-drop-zone";

const STATUS_POLLING_INTERVAL_MILLIS = 10000;

export default class VideoUpload extends Component {
  @service a11y;
  @service appEvents;
  @service currentUser;
  @service dialog;
  @service toasts;

  @tracked uploadProgress = 0;
  @tracked isAuthing = false;
  @tracked isUploading = false;
  @tracked isProcessing = false;
  @tracked isPaused = false;
  @tracked uploadError = null;
  @tracked isCancelling = false;
  @tracked selectedProvider = this.defaultProvider;
  @tracked embeddableUrl = null;

  uploader = null;
  cancelRequested = false;
  completed = false;
  insertEarlyRequested = false;
  insertEmbed = null;

  privacy = settings.youtube_default_view_privacy;
  provider = this.defaultProvider;
  vimeoEmbedPrivacy = settings.vimeo_default_embed_privacy;
  vimeoViewPrivacy = settings.vimeo_default_view_privacy;

  @cached
  get formData() {
    return {
      title: this.title,
      description: this.description,
      privacy: this.privacy,
      provider: this.provider,
      video: this.video,
      vimeoEmbedPrivacy: this.vimeoEmbedPrivacy,
      vimeoViewPrivacy: this.vimeoViewPrivacy,
    };
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

  get providers() {
    return [
      {
        id: "youtube",
        enabled: settings.youtube_upload_enabled,
        icon: "fab-youtube",
        labelKey: "provider.youtube",
        submitKey: "upload.youtube",
        handler: "youtubeUpload",
      },
      {
        id: "vimeo",
        enabled: settings.vimeo_upload_enabled,
        icon: "fab-vimeo-v",
        labelKey: "provider.vimeo",
        submitKey: "upload.vimeo",
        handler: "vimeoUpload",
      },
      {
        id: "cloudflare_stream",
        enabled: settings.cloudflare_stream_upload_enabled,
        icon: "fab-cloudflare",
        labelKey: "provider.cloudflare_stream",
        submitKey: "upload.cloudflare",
        handler: "cloudflareUpload",
      },
      {
        id: "mux",
        enabled: settings.mux_upload_enabled,
        icon: "video",
        labelKey: "provider.mux",
        submitKey: "upload.mux",
        handler: "muxUpload",
      },
    ];
  }

  get enabledProviders() {
    return this.providers.filter((provider) => provider.enabled);
  }

  get defaultProvider() {
    return this.enabledProviders.length === 1
      ? this.enabledProviders[0].id
      : null;
  }

  get providerSelectionEnabled() {
    return this.enabledProviders.length > 1;
  }

  get selectedProviderConfig() {
    return this.providers.find((p) => p.id === this.selectedProvider);
  }

  get submitIcon() {
    return this.selectedProviderConfig?.icon ?? "video";
  }

  get submitLabel() {
    const key = this.selectedProviderConfig?.submitKey ?? "upload.video";
    return i18n(themePrefix(key));
  }

  get brokerOrigin() {
    return settings.video_broker_origin?.trim();
  }

  @action
  registerApi(api) {
    this.formApi = api;
  }

  @action
  handleProviderChange(setProvider, value) {
    this.uploadError = null;
    this.formApi?.removeError("privacy");

    setProvider(value);
    this.selectedProvider = value;
  }

  @action
  async handleFilesSelected(files) {
    const file = files?.[0];

    if (!this.validateVideoFile(file)) {
      return;
    }

    if (await this.exceedsMaxDuration(file)) {
      this.formApi.set("video", null);
      this.formApi.addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.too_long"), {
          max: settings.max_duration_minutes,
        }),
      });
    }
  }

  exceedsMaxSize(file) {
    const maxMb = settings.max_upload_size_mb;
    return maxMb > 0 && file.size > maxMb * 1024 * 1024;
  }

  durationExceedsLimit(durationSeconds) {
    const maxMinutes = settings.max_duration_minutes;
    return (
      maxMinutes > 0 &&
      durationSeconds != null &&
      durationSeconds > maxMinutes * 60
    );
  }

  readVideoDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";

      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(video.duration) ? video.duration : null);
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      video.src = url;
    });
  }

  async exceedsMaxDuration(file) {
    if (settings.max_duration_minutes <= 0) {
      return false;
    }

    const duration = await this.readVideoDuration(file);
    return this.durationExceedsLimit(duration);
  }

  @action
  validateVideoFile(file) {
    if (!file) {
      this.formApi.set("video", null);
      return false;
    }

    if (!file.type.startsWith("video/")) {
      this.formApi.set("video", null);

      this.formApi.addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.invalid")),
      });
      return false;
    }

    if (this.exceedsMaxSize(file)) {
      this.formApi.set("video", null);

      this.formApi.addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.too_large"), {
          max: settings.max_upload_size_mb,
        }),
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
  clearVideoFile() {
    this.formApi.removeError("video");
    this.formApi.set("video", null);
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

    if (data.video && this.exceedsMaxSize(data.video)) {
      addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.too_large"), {
          max: settings.max_upload_size_mb,
        }),
      });
    }

    if (!data.title) {
      addError("title", {
        title: i18n(themePrefix("details.title")),
        message: i18n(themePrefix("validation.title.required")),
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

  get processingTimeout() {
    const minutes = settings.processing_wait_timeout_minutes;
    return minutes > 0 ? minutes * 60 * 1000 : Infinity;
  }

  get progressBarStyle() {
    return htmlSafe(`width: ${this.uploadProgress}%`);
  }

  get isModalDismissable() {
    return !this.uploadDisabled || this.isPaused;
  }

  updateProgress(data) {
    if (!data.total) {
      return;
    }

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
    this.embeddableUrl = null;
    this.a11y.announce(i18n(themePrefix("status.announce.uploading")));
  }

  startProcessing() {
    this.uploadProgress = 0;
    this.isUploading = false;
    this.isProcessing = true;
    this.a11y.announce(i18n(themePrefix("status.announce.transcoding")));
  }

  finishProcessing() {
    this.isProcessing = false;
    this.a11y.announce(i18n(themePrefix("status.announce.complete")));
  }

  failUpload(error) {
    this.uploadProgress = 0;
    this.isAuthing = false;
    this.isUploading = false;
    this.isProcessing = false;
    this.uploadError = uploadErrorMessage(error);
    this.a11y.announce(
      i18n(themePrefix("status.error.upload"), { error: this.uploadError }),
      "assertive"
    );
  }

  notifyStillProcessing(provider) {
    this.toasts.success({
      data: {
        title: i18n(themePrefix("notices.still_processing_title")),
        message: i18n(themePrefix(`notices.still_processing_${provider}`)),
      },
    });
  }

  notifyDeleteFailed(provider, error) {
    // eslint-disable-next-line no-console
    console.warn(`${provider} cancel: failed to delete uploaded video`, error);

    this.toasts.warning({
      data: {
        title: i18n(themePrefix("cancel.delete_failed_title")),
        message: i18n(themePrefix(`cancel.delete_failed_${provider}`)),
      },
    });
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
    this.embeddableUrl = null;
    this.completed = false;
    this.insertEarlyRequested = false;
    this.insertEmbed = null;
    this.a11y.announce(i18n(themePrefix("status.announce.cancelled")));
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

    if (!this.isAuthing) {
      const confirmed = await this.dialog.yesNoConfirm({
        message: i18n(themePrefix("upload.cancel_confirm")),
      });

      if (!confirmed) {
        return;
      }
    }

    this.isCancelling = true;
    this.cancelRequested = true;
    this.uploader?.cancel();
  }

  @action
  submitUpload() {
    this.formApi?.submit();
  }

  @action
  async handleSubmit(data) {
    if (data.video && (await this.exceedsMaxDuration(data.video))) {
      this.formApi.addError("video", {
        title: i18n(themePrefix("upload.video")),
        message: i18n(themePrefix("validation.video.too_long"), {
          max: settings.max_duration_minutes,
        }),
      });
      return;
    }

    const config = this.providers.find((p) => p.id === data.provider);
    if (config) {
      await this[config.handler](data);
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

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      await uploader.upload();

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      this.startProcessing();

      const { video, timedOut } = await uploader.waitForYoutubeProcessing(
        accessToken,
        {
          interval: STATUS_POLLING_INTERVAL_MILLIS,
          timeout: this.processingTimeout,
          shouldCancel: () => this.cancelRequested,
        }
      );

      this.finishProcessing();

      if (timedOut) {
        this.notifyStillProcessing("youtube");
      }

      const videoId = uploader.videoId ?? video?.id;
      this.appEvents.trigger(
        "composer:insert-block",
        `\nhttps://youtube.com/watch?v=${videoId}\n`
      );
      this.closeUploadModal();
    } catch (error) {
      if (error?.cancelled) {
        try {
          await this.uploader?.deleteVideo();
        } catch (deleteError) {
          this.notifyDeleteFailed("youtube", deleteError);
        }
        this.resetUpload();
        return;
      }
      if (error?.status === 401) {
        clearYoutubeToken(settings.youtube_api_client_id);
      }
      if (error?.cleanup) {
        try {
          await this.uploader?.deleteVideo();
        } catch {}
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
          shouldCancel: () => this.cancelRequested,
        });
      } catch (error) {
        if (error?.cancelled) {
          this.resetUpload();
        } else {
          this.failUpload(error);
        }
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
      if (this.cancelRequested) {
        throw new CancelledError();
      }

      const videoUri = await uploadInst.upload();

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      const videoId = videoUri.split("/").pop();
      const uploadUrl = uploadInst.videoLink ?? `https://vimeo.com/${videoId}`;

      this.startProcessing();

      const { timedOut } = await uploadInst.waitForTranscode({
        interval: STATUS_POLLING_INTERVAL_MILLIS,
        timeout: this.processingTimeout,
        shouldCancel: () => this.cancelRequested,
      });

      this.finishProcessing();

      if (timedOut) {
        this.notifyStillProcessing("vimeo");
      }

      this.appEvents.trigger("composer:insert-block", `\n${uploadUrl}\n`);
      this.closeUploadModal();
    } catch (error) {
      if (error?.cancelled) {
        try {
          await uploadInst.deleteVideo();
        } catch (deleteError) {
          this.notifyDeleteFailed("vimeo", deleteError);
        }
        this.resetUpload();
        return;
      }
      if (error?.status === 401 && settings.vimeo_oauth_client_id) {
        clearVimeoToken(this.currentUser.id);
      }
      if (error?.cleanup) {
        try {
          await uploadInst.deleteVideo();
        } catch {}
      }
      this.failUpload(error);
    }
  }

  @action
  async cloudflareUpload(data) {
    await this.brokerUpload(data, {
      provider: "cloudflare_stream",
      ClientClass: CloudflareStreamUploadClient,
      metadata: buildCloudflareStreamMetadata(data),
      insert: (url) =>
        this.appEvents.trigger("composer:insert-block", `\n${url}\n`),
    });
  }

  @action
  async muxUpload(data) {
    await this.brokerUpload(data, {
      provider: "mux",
      ClientClass: MuxUploadClient,
      metadata: buildMuxMetadata(data),
      insert: (url) =>
        this.appEvents.trigger("composer:insert-block", `\n${url}\n`),
    });
  }

  async brokerUpload(data, { provider, ClientClass, metadata, insert }) {
    let uploader;
    this.completed = false;
    this.insertEarlyRequested = false;
    this.insertEmbed = insert;
    try {
      this.isAuthing = true;
      this.uploadError = null;

      const token = await requestBrokerToken({
        brokerOrigin: this.brokerOrigin,
        shouldCancel: () => this.cancelRequested,
      });

      this.startUpload();

      uploader = new ClientClass({
        file: data.video,
        token,
        brokerOrigin: this.brokerOrigin,
        metadata,
        onProgress: (progressData) => this.updateProgress(progressData),
      });
      this.uploader = uploader;

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      await uploader.upload();

      if (this.cancelRequested) {
        throw new CancelledError();
      }

      this.startProcessing();

      const { timedOut, iframeUrl } = await uploader.waitForReady({
        interval: STATUS_POLLING_INTERVAL_MILLIS,
        timeout: this.processingTimeout,
        shouldCancel: () => this.cancelRequested,
        onEmbeddable: (url) => (this.embeddableUrl = url),
        shouldInsertEarly: () => this.insertEarlyRequested,
      });

      this.finishProcessing();

      // The "Insert now" button may have already inserted and closed.
      if (this.completed) {
        return;
      }

      if (timedOut) {
        this.notifyStillProcessing(provider);
      }

      this.finishInsert(iframeUrl);
    } catch (error) {
      if (error?.cancelled) {
        try {
          await uploader?.deleteVideo();
        } catch (deleteError) {
          this.notifyDeleteFailed(provider, deleteError);
        }
        this.resetUpload();
        return;
      }
      if (error?.status === 401) {
        clearBrokerToken();
      }
      if (error?.cleanup) {
        try {
          await uploader?.deleteVideo();
        } catch {}
      }
      this.failUpload(error);
    } finally {
      this.isAuthing = false;
    }
  }

  finishInsert(url) {
    if (this.completed) {
      return;
    }

    this.completed = true;
    this.insertEmbed?.(url);
    this.closeUploadModal();
  }

  @action
  insertNow() {
    if (!this.embeddableUrl || this.completed) {
      return;
    }

    this.insertEarlyRequested = true;
    this.finishProcessing();
    this.finishInsert(this.embeddableUrl);
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
      @autofocus={{false}}
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
              <div
                class="video-upload-provider-choice
                  {{unless this.selectedProvider '--empty'}}"
              >
                {{#unless this.selectedProvider}}
                  <p class="video-upload-provider-choice__hint">
                    {{i18n (themePrefix "provider.choose_hint")}}
                  </p>
                {{/unless}}

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
                          {{#each this.enabledProviders as |provider|}}
                            <Condition
                              @name={{provider.id}}
                              @disabled={{this.uploadDisabled}}
                            >
                              {{#if (eq this.selectedProvider provider.id)}}
                                {{icon "check"}}
                              {{/if}}
                              {{i18n (themePrefix provider.labelKey)}}
                            </Condition>
                          {{/each}}
                        </conditional.Conditions>
                      </form.ConditionalContent>
                    </form.Container>
                  </field.Control>
                </form.Field>
              </div>
            {{/if}}

            {{#if this.selectedProvider}}
              <div class="video-upload-form-reveal">
                <form.Field
                  @name="video"
                  @title={{i18n (themePrefix "upload.video")}}
                  @type="custom"
                  @format="full"
                  @validation="required"
                  as |field|
                >
                  <field.Control>
                    <VideoDropZone
                      @file={{field.value}}
                      @inputId={{field.id}}
                      @disabled={{this.uploadDisabled}}
                      @onFileSelected={{this.handleFilesSelected}}
                      @onClear={{this.clearVideoFile}}
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
                    disabled={{this.uploadDisabled}}
                    placeholder={{i18n (themePrefix "details.title")}}
                  />
                </form.Field>

                <form.Field
                  @name="description"
                  @title={{i18n (themePrefix "details.description")}}
                  @type="textarea"
                  @format="full"
                  as |field|
                >
                  <field.Control
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
                        @title={{i18n
                          (themePrefix "provider.youtube_settings")
                        }}
                      >
                        <form.Field
                          @name="privacy"
                          @title={{i18n (themePrefix "details.privacy")}}
                          @validation="required"
                          @type="select"
                          as |field|
                        >
                          <field.Control
                            disabled={{this.uploadDisabled}}
                            as |select|
                          >
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
                        @title={{i18n (themePrefix "provider.vimeo_settings")}}
                      >
                        <form.Row as |row|>
                          <row.Col @size={{6}}>
                            <form.Field
                              @name="vimeoViewPrivacy"
                              @title={{i18n
                                (themePrefix "details.vimeo_view_privacy")
                              }}
                              @helpText={{i18n
                                (themePrefix "details.vimeo_view_privacy_help")
                              }}
                              @validation="required"
                              @type="select"
                              as |field|
                            >
                              <field.Control
                                disabled={{this.uploadDisabled}}
                                as |select|
                              >
                                <select.Option @value="anybody">
                                  {{i18n
                                    (themePrefix "details.vimeo_view.anybody")
                                  }}
                                </select.Option>
                                <select.Option @value="unlisted">
                                  {{i18n
                                    (themePrefix "details.vimeo_view.unlisted")
                                  }}
                                </select.Option>
                                <select.Option @value="disable">
                                  {{i18n
                                    (themePrefix "details.vimeo_view.disable")
                                  }}
                                </select.Option>
                              </field.Control>
                            </form.Field>
                          </row.Col>

                          <row.Col @size={{6}}>
                            <form.Field
                              @name="vimeoEmbedPrivacy"
                              @title={{i18n
                                (themePrefix "details.vimeo_embed_privacy")
                              }}
                              @validation="required"
                              @type="select"
                              as |field|
                            >
                              <field.Control
                                disabled={{this.uploadDisabled}}
                                as |select|
                              >
                                <select.Option @value="public">
                                  {{i18n
                                    (themePrefix "details.vimeo_embed.public")
                                  }}
                                </select.Option>
                                <select.Option @value="private">
                                  {{i18n
                                    (themePrefix "details.vimeo_embed.private")
                                  }}
                                </select.Option>
                              </field.Control>
                            </form.Field>
                          </row.Col>
                        </form.Row>
                      </form.Section>
                    </Content>
                  </conditional.Contents>
                </form.ConditionalContent>
              </div>
            {{/if}}
          </form.Section>
        </Form>
      </:body>

      <:footer>
        {{#if this.isUploading}}
          <div
            class="video-upload-progress {{if this.isPaused '--paused'}}"
            role="progressbar"
            aria-label={{i18n (themePrefix "status.upload_progress_label")}}
            aria-valuenow={{this.uploadProgress}}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="video-upload-progress__bar"
              style={{this.progressBarStyle}}
            ></div>
          </div>
        {{/if}}

        {{#if this.selectedProvider}}
          <DButton
            @action={{this.submitUpload}}
            class="btn-primary"
            @icon={{this.submitIcon}}
            @disabled={{this.uploadDisabled}}
            @translatedLabel={{this.submitLabel}}
          />
        {{/if}}

        {{#if this.hasStatus}}
          <div class="video-upload-status">
            {{#if this.isCancelling}}
              <div class="video-upload-status__line">
                <span>{{i18n (themePrefix "status.cancelling")}}</span>
                <div class="spinner" aria-hidden="true"></div>
              </div>
            {{else}}
              {{#if this.isAuthing}}
                <div class="video-upload-status__line">
                  <span>{{i18n (themePrefix "status.authenticating")}}</span>
                  <div class="spinner" aria-hidden="true"></div>
                  <div class="video-upload-status__controls">
                    <DButton
                      @action={{this.cancelUpload}}
                      @icon="xmark"
                      class="btn-small"
                      @translatedLabel={{i18n (themePrefix "upload.cancel")}}
                    />
                  </div>
                </div>
              {{/if}}

              {{#if this.isUploading}}
                <div class="video-upload-status__line">
                  <span>
                    {{#if this.isPaused}}
                      {{i18n
                        (themePrefix "status.paused_progress")
                        progress=this.uploadProgress
                      }}
                    {{else}}
                      {{i18n
                        (themePrefix "status.uploading")
                        progress=this.uploadProgress
                      }}
                    {{/if}}
                  </span>
                  <div class="video-upload-status__controls">
                    {{#if this.isPaused}}
                      <DButton
                        @action={{this.resumeUpload}}
                        @icon="play"
                        class="btn-small"
                        @translatedLabel={{i18n (themePrefix "upload.resume")}}
                      />
                    {{else}}
                      <DButton
                        @action={{this.pauseUpload}}
                        @icon="pause"
                        class="btn-small"
                        @translatedLabel={{i18n (themePrefix "upload.pause")}}
                      />
                    {{/if}}
                    <DButton
                      @action={{this.cancelUpload}}
                      @icon="xmark"
                      class="btn-small"
                      @translatedLabel={{i18n (themePrefix "upload.cancel")}}
                    />
                  </div>
                </div>
              {{/if}}

              {{#if this.isProcessing}}
                <div class="video-upload-status__line">
                  <span>{{i18n (themePrefix "status.transcoding")}}</span>
                  <div class="spinner" aria-hidden="true"></div>
                  <div class="video-upload-status__controls">
                    {{#if this.embeddableUrl}}
                      <DButton
                        @action={{this.insertNow}}
                        @icon="check"
                        class="btn-small"
                        @translatedLabel={{i18n
                          (themePrefix "upload.insert_now")
                        }}
                      />
                    {{/if}}
                    <DButton
                      @action={{this.cancelUpload}}
                      @icon="xmark"
                      class="btn-small"
                      @translatedLabel={{i18n (themePrefix "upload.cancel")}}
                    />
                  </div>
                </div>
              {{/if}}

              {{#if this.uploadError}}
                <div class="video-upload-status__line --error">
                  <span>{{i18n
                      (themePrefix "status.error.upload")
                      error=this.uploadError
                    }}</span>
                </div>
              {{/if}}
            {{/if}}
          </div>
        {{/if}}
      </:footer>
    </DModal>
  </template>
}
