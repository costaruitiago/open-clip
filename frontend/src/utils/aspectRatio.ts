export type VideoOutputSettings = {
  resolution?: string;
  aspect_ratio?: string;
  layout?: string;
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

/** What a rendered file records about the shape it was cut to. */
export type RenderedOutput = {
  rendered_aspect_ratio?: string | null;
  rendered_resolution?: string | null;
  rendered_layout?: string | null;
};

/** "keep original" and an unset setting are the same instruction. */
const outputChoice = (value: string | null | undefined) => value?.trim() || 'keep original';

/**
 * Whether a cut file was rendered with the output settings now in force.
 *
 * Changing the project's aspect ratio or resolution re-shapes every clip and
 * re-cuts nothing, so a file made under the old settings is not what the
 * project now describes — playing it under a preview boxed to the new shape
 * shows a crop that does not exist and will not be produced. False here is what
 * sends the card back to previewing from the source until the clip is re-cut.
 *
 * A file that recorded neither value was cut before this was tracked. That is
 * read as matching, since the alternative is declaring every clip in every
 * existing project stale on upgrade.
 */
export const matchesOutputSettings = (
  settings: VideoOutputSettings | undefined,
  rendered: RenderedOutput | undefined
): boolean => {
  if (!rendered?.rendered_aspect_ratio && !rendered?.rendered_resolution) return true;
  return (
    outputChoice(rendered.rendered_aspect_ratio) === outputChoice(settings?.aspect_ratio) &&
    outputChoice(rendered.rendered_resolution) === outputChoice(settings?.resolution) &&
    // Unset on either side is a crop: files cut before layouts existed, and
    // projects that never chose one.
    (rendered.rendered_layout || 'crop') === (settings?.layout || 'crop')
  );
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
