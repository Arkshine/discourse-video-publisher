export function buildYoutubeMetadata({ title, description, privacy }) {
  return {
    snippet: {
      title,
      description,
    },
    status: {
      privacyStatus: privacy,
    },
  };
}

export function buildYoutubeMetadataParts(metadata) {
  return Object.keys(metadata).join(",");
}

export function buildVimeoMetadata(
  { title, description, vimeoEmbedPrivacy, vimeoViewPrivacy },
  { username, viewPrivacy, embedPrivacy }
) {
  const attribution = `by @${username}`;

  return {
    name: title,
    description: description ? `${description}\n${attribution}` : attribution,
    privacy: {
      view: vimeoViewPrivacy || viewPrivacy,
      embed: vimeoEmbedPrivacy || embedPrivacy,
    },
  };
}

export function buildCloudflareStreamMetadata({ title }) {
  return { title };
}

export function buildMuxMetadata({ title }) {
  return { title };
}
