# Discourse Video Publisher

Upload videos directly from the Discourse composer to YouTube or Vimeo and automatically insert the resulting video link into your post once processing is complete.

> ℹ️ This is a continuation of the original work made by @ti0 here https://meta.discourse.org/t/video-upload-to-youtube-and-vimeo-using-theme-component/170079 and contains various fixes and improvements.

## Features

- Upload videos to YouTube, Vimeo, or both directly from the composer toolbar
- Automatic insertion of the video URL into the post after processing completes
- Support for YouTube uploads to each user's personal channel via OAuth
- Two Vimeo upload modes:
  - User-owned uploads via OAuth
  - Shared account uploads via a static access token
- Configurable default privacy settings
- Upload progress tracking with pause and resume support
- Cancel uploads or processing and automatically remove the uploaded video
- Wait for transcoding to finish before inserting the video link
- Restrict access to the upload button by user's group

## Configuration

### YouTube

Videos are uploaded to the authenticated user's YouTube channel. Users authorize access through Google's OAuth flow.

**1. Create a project and enable the API**

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project
3. Enable the **YouTube Data API v3** (**APIs & Services → Library** or search _youtube_)

**2. Configure the OAuth consent screen**

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** (or **Internal** if all users belong to one Google Workspace organization — Internal skips the verification and warning described below)
3. Complete the required application details.
4. Under **Data access** (scopes), add `../auth/youtube` scope. This scope allows the component to upload, check processing status, and delete videos when uploads are cancelled.

**3. Publish the application**

New applications start in Testing mode (**OAuth consent screen → Audience**) and can only be used by designated test users.

For production use, click **Publish app**. then complete Google's OAuth verification process for the YouTube scope (more information here: https://support.google.com/cloud/answer/13464321).

**4. Create the OAuth client ID**

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**
2. Application type: **Web application**
3. Under **Authorized JavaScript origins**, add your Discourse instance URL (e.g. `https://forum.example.com`)
4. Copy the generated **Client ID**

**Discourse settings:**

| Setting                        | Value                                        |
| ------------------------------ | -------------------------------------------- |
| `youtube upload enabled`       | Enable                                       |
| `youtube api client id`        | Paste the Client ID                          |
| `youtube default view privacy` | `unlisted` (default), `public`, or `private` |

---

### Vimeo

Vimeo supports two upload methods.

#### Mode 1 — Per-user OAuth (recommended)

Each user connects their own Vimeo account and uploads videos they personally own.

**Vimeo developer setup:**

1. Go to [Vimeo Developer Portal](https://developer.vimeo.com/apps/new) and create an app
2. On the app page, **Request upload access**
3. Add your Discourse site's root URL as an OAuth callback URL: **OAuth 2 → Authentication callback URLs**.
   Example: `https://forum.example.com`
4. Copy the applucation **Client ID**

**Discourse settings**

| Setting                 | Value               |
| ----------------------- | ------------------- |
| `vimeo upload enabled`  | Enable              |
| `vimeo oauth client id` | Paste the Client ID |

#### Mode 2 — Shared account (static token)

All uploads go to a single Vimeo account. Leave `vimeo oauth client id` empty and use a static access token instead.

> ⚠️ **Security Warning**
>
> Theme settings are delivered to every visitor's browser. This means anyone can extract the Vimeo access token and use it directly against your Vimeo account.
>
> Depending on the token permissions, attackers may be able to:
>
> - Upload content
> - Modify video settings
> - Delete videos
>
> If you're unsure which mode to use, choose **OAuth mode** instead.

**Vimeo setup**

1. Go to [developer.vimeo.com/apps/new](https://developer.vimeo.com/apps/new) and create an app
2. On the app page, click **Request upload access**
3. Go to **Generate an access token** and create a token with the **Upload**, **Edit**, and **Delete** scopes (Edit is used to set privacy on uploaded videos; Delete is used to clean up videos when an upload is cancelled)
4. Copy the generated token

**Discourse settings:**

| Setting                  | Value                  |
| ------------------------ | ---------------------- |
| `vimeo upload enabled`   | Enable                 |
| `vimeo oauth client id`  | Leave empty            |
| `vimeo api access token` | Paste the access token |

#### Vimeo privacy defaults

These settings apply to shared-token uploads and act as defaults for OAuth uploads.

| Setting                       | Options                          |
| ----------------------------- | -------------------------------- |
| `vimeo default view privacy`  | `anybody`, `unlisted`, `disable` |
| `vimeo default embed privacy` | `public`, `private`              |

> `unlisted` and `disable` require a paid Vimeo plan.

---

### Access control

| Setting          | Value                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `allowed groups` | Groups whose members can see and use the video upload toolbar button. |

---

## Usage

1. Open the composer (new topic or reply)
2. Click the **video camera** icon in the composer toolbar
3. Select a video file
4. Fill in the title and any optional details
5. Click **Upload to YouTube** or **Upload to Vimeo**
6. Upload progress is shown — use **Pause** and **Resume** as needed
7. To abort, click **Cancel** and confirm — the upload is stopped and the video is deleted from the provider. If the deletion fails (for example, if the access token is missing the required scopes or the provider is rate-limiting), a warning toast is shown so you can remove the video manually.
8. Once transcoding completes, the video link is automatically inserted into the composer
