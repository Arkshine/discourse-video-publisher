export async function extractVideoPreview(file, { timeoutMs = 10000 } = {}) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");

  return new Promise((resolve) => {
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);

      try {
        video.removeAttribute("src");
        video.load();
      } catch {}

      URL.revokeObjectURL(objectUrl);
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => finish(null), timeoutMs);

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    video.addEventListener("error", () => finish(null), { once: true });

    video.addEventListener(
      "loadedmetadata",
      () => {
        const { duration, videoWidth: width, videoHeight: height } = video;

        if (!width || !height || !Number.isFinite(duration)) {
          finish(null);
          return;
        }

        video.addEventListener(
          "seeked",
          async () => {
            try {
              await new Promise((_resolve) => requestAnimationFrame(_resolve));

              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;

              const context = canvas.getContext("2d");
              if (!context) {
                finish(null);
                return;
              }

              context.drawImage(video, 0, 0, width, height);

              const posterUrl = canvas.toDataURL("image/jpeg", 0.7);
              finish({ posterUrl, duration, width, height });
            } catch {
              finish(null);
            }
          },
          { once: true }
        );

        const minTime = Math.min(1, duration);
        const maxTime = Math.max(minTime, duration - 1);

        video.currentTime = Math.min(Math.max(duration / 2, minTime), maxTime);
      },
      { once: true }
    );

    video.src = objectUrl;
  });
}

export function formatDuration(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

export function resolutionLabel(width, height) {
  if (!width || !height) {
    return null;
  }

  const normalizedHeight = Math.min(width, height);

  const tiers = {
    2160: "4K",
    1440: "1440p",
    1080: "1080p",
    720: "720p",
    480: "480p",
  };

  return tiers[normalizedHeight] ?? `${width}×${height}`;
}
