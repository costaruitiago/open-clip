import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CaptionOverlay } from './CaptionOverlay';
import { StackedBands, stackBandFraction, useStackLayout } from './StackedBands';
import { TextOverlay } from './TextOverlay';
import type { CaptionFont, CaptionPreview, OverlayText, ThumbnailSettings } from '../../api';

interface ThumbnailPreviewProps {
  /** The *source* video. Never the cut clip — see below. */
  src: string;
  /** Where the frame sits in the source: the clip's start plus `frame_time`. */
  sourceTime: number;
  /** Target width / height, so the frame is cropped the way the render crops it. */
  aspectRatio: number | null;
  /** How this clip's thumbnail is built: which frame, and what is drawn on it. */
  settings: ThumbnailSettings;
  /** The text the burn would draw, resolved by the backend. */
  title: OverlayText | null;
  /** The face that title will be burned with. */
  font?: CaptionFont | null;
  /** The clip's cues and style, for a thumbnail that shows the subtitles. */
  captions?: CaptionPreview | null;
  /** Starts the clip, so clicking the still does what clicking a player does. */
  onClick?: () => void;
}

/**
 * The thumbnail as it would come out, drawn over whatever else is on screen.
 *
 * The browser half of `Thumbnailer` on the backend, the way `CaptionOverlay` is
 * the browser half of the caption burn: one description, two renderers. It is
 * what lets a clip show its thumbnail with no picture rendered anywhere — a
 * still is a frame with text on it, and both of those can be drawn here.
 *
 * It carries its own frame rather than borrowing the player's, because the two
 * are not frames of the same thing. A thumbnail is cut from the **source**:
 * `extract_frame` seeks the original video and applies the clipper's crop, so
 * nothing that was burned into the clip file — captions, the overlay title —
 * is in it. Drawn over a rendered clip instead, the still would show burned
 * subtitles this thumbnail explicitly switched off, and show the title twice.
 *
 * Everything is drawn at `frame_time` and held. A still has no timeline: no
 * fades, and no waiting for a word's turn.
 */
export const ThumbnailPreview: React.FC<ThumbnailPreviewProps> = ({
  src,
  sourceTime,
  aspectRatio,
  settings,
  title,
  font,
  captions = null,
  onClick,
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  // Cut from the source like the render's still, so stacked like it too.
  const [sourceRatio, setSourceRatio] = useState<number | null>(null);
  const stack = useStackLayout();
  const band = stack ? stackBandFraction(aspectRatio, sourceRatio) : 0;

  const seek = useCallback(() => {
    const video = ref.current;
    if (video) video.currentTime = Math.max(0, sourceTime);
  }, [sourceTime]);

  // Seeking is what draws the frame: a <video> with no playback shows whatever
  // it decoded last, which before the seek is the first frame of the whole
  // source rather than of this clip.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    seek();
    if (video.readyState >= 1) return;
    video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [src, seek]);

  return (
    <div
      // Decorative: the clip is already named on the card, and the words drawn
      // here are the clip's own title, which is on the page as text.
      aria-hidden="true"
      onClick={onClick}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        backgroundColor: '#000',
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <video
        ref={ref}
        src={src}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={() => {
          const { videoWidth, videoHeight } = ref.current ?? {};
          if (videoWidth && videoHeight) setSourceRatio(videoWidth / videoHeight);
        }}
        // Filled rather than letterboxed: the render crops the source to the
        // output frame, and this box is already that shape. Stacked, the whole
        // frame sits between the bands instead.
        style={
          band > 0
            ? {
                position: 'absolute',
                left: 0,
                top: `${band * 100}%`,
                width: '100%',
                height: `${(1 - 2 * band) * 100}%`,
                objectFit: 'contain',
                display: 'block',
                pointerEvents: 'none',
              }
            : {
                width: '100%',
                height: '100%',
                objectFit: aspectRatio ? 'cover' : 'contain',
                display: 'block',
                pointerEvents: 'none',
              }
        }
      />
      {band > 0 && stack && <StackedBands video={ref} band={band} darkness={stack.darkness} />}
      {/* Off by default, and drawn from the cues rather than from pixels: a
          thumbnail that says no subtitles has none, whatever the clip file
          happens to carry. */}
      {settings.show_captions && captions?.cues?.length ? (
        <CaptionOverlay
          cues={captions.cues}
          style={captions.style}
          font={captions.font}
          time={settings.frame_time}
        />
      ) : null}
      {settings.show_overlay && title?.text.trim() ? (
        <TextOverlay overlay={title} font={font} time={settings.frame_time} forceVisible />
      ) : null}
      {settings.extra?.text.trim() ? (
        <TextOverlay overlay={settings.extra} font={font} time={settings.frame_time} forceVisible />
      ) : null}
    </div>
  );
};
