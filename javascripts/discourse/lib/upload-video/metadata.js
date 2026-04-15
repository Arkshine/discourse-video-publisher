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
  return {
    name: title,
    description: `${description}\nby @${username}`,
    privacy: {
      view: vimeoViewPrivacy || viewPrivacy,
      embed: vimeoEmbedPrivacy || embedPrivacy,
    },
  };
}
