type VideoOutputSettings = {
  resolution?: string;
  aspect_ratio?: string;
};

/**
 * The frame shape the clipper will actually render, as width / height.
 *
 * Mirrors `_resolve_target_dimensions` in
 * backend/src/infrastructure/video_engine.py, including the part that catches
 * people out: a fixed resolution wins outright, so "9:16" with "1080p" renders
 * 1920x1080 — landscape — not a vertical clip. The preview has to show that,
 * otherwise it is reassuring about a framing the render will not produce.
 *
 * Returns null when the render keeps the source framing, in which case the
 * preview should play at the video's natural ratio.
 */
export const targetAspectRatio = (
  settings: VideoOutputSettings | undefined,
  aspectRatios: Record<string, string> | undefined,
  resolutions: Record<string, string> | undefined
): number | null => {
  const resolution = settings?.resolution ?? 'keep original';
  if (resolution !== 'keep original') {
    const [width, height] = (resolutions?.[resolution] ?? resolution).split('x').map(Number);
    if (width > 0 && height > 0) return width / height;
  }

  const configured = settings?.aspect_ratio ?? '';
  const [ratioWidth, ratioHeight] = (aspectRatios?.[configured] ?? configured).split(':').map(Number);
  if (ratioWidth > 0 && ratioHeight > 0) return ratioWidth / ratioHeight;

  return null;
};

/** Seconds as `m:ss`, or `h:mm:ss` once a clip runs past an hour. */
export const formatTimecode = (seconds: number): string => {
  // A highlight missing `start`/`end` reaches here as undefined, and the
  // arithmetic below turns that into the string "NaN:NaN" on the card.
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const secs = String(total % 60).padStart(2, '0');
  const mins = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
};
