import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatTimecode } from '../../utils/aspectRatio';
import { useVttUrl } from '../../utils/vtt';
import { SplitHalves, StackedBands, splitApplies, stackBandFraction, useStackLayout } from './StackedBands';
import type { CaptionCue } from '../../api';

interface ClipPlayerProps {
  /** Either the full source video, or a clip the clipper has already cut. */
  src: string;
  /** Offset of the clip inside `src`. Zero for a file that is already the cut. */
  start?: number;
  /** End of the window inside `src`, or null to play `src` to its end. */
  end?: number | null;
  /** Target width / height, or null to keep the source framing. */
  aspectRatio: number | null;
  /** True while `src` is the uncut source and the window is being simulated. */
  isPreview?: boolean;
  label: string;
  /** Set while another clip is playing, so only one plays at a time. */
  shouldPause?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  /**
   * Drawn inside the framed area, given the position within the window and
   * whether the picture is moving. Anything that animates over time — a fade —
   * has nothing to show on a paused frame, so the overlay needs to know.
   */
  renderOverlay?: (position: number, isPlaying: boolean) => React.ReactNode;
  /**
   * Attached as a real text track. Burned-in captions are pixels — legible, but
   * invisible to a screen reader and unsearchable — so the cues are offered
   * here whether or not anything is drawn over the picture.
   */
  cues?: CaptionCue[];
  /**
   * Where inside the window to park on load, in seconds from `start`.
   *
   * For picking a frame rather than watching one: a player opened on a chosen
   * frame has to open there, not rewind to the top of the clip.
   */
  initialOffset?: number;
  /** Reports the playhead, so a caller can act on the frame being shown. */
  onPositionChange?: (position: number) => void;
  /**
   * How long `src` itself is, once the browser has read its metadata.
   *
   * Only the media element knows this, and a caller moving the window — a trim
   * — has to know where the source ends before it can stop the user dragging
   * past it.
   */
  onSourceDuration?: (seconds: number) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The one player for a clip, before and after the clipper has cut it.
 *
 * Both states are the same object at different stages, so they are played by
 * the same control: the same boxed frame at the ratio the render targets, the
 * same transport under it, the same caption overlay inside it. A rendered clip
 * used to get the browser's native controls and its own natural box, which made
 * a card visibly change shape and gain a different set of buttons the moment
 * the render landed.
 *
 * The transport is custom rather than the browser's because a preview plays
 * from the uncut source: native controls scrub the whole source, and the point
 * of a preview is that the window between `start` and `end` is all there is to
 * see. Playback is clamped to that window and repeats inside it, so what the
 * render will produce is visible before paying to encode it.
 */
export const ClipPlayer: React.FC<ClipPlayerProps> = ({
  src,
  start = 0,
  end = null,
  aspectRatio,
  isPreview = false,
  label,
  shouldPause,
  onPlay,
  onPause,
  renderOverlay,
  cues,
  initialOffset = 0,
  onPositionChange,
  onSourceDuration,
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Seeded with the offset the caller asked to open on, rather than zero: the
  // seek below cannot run until the media element has metadata, and until then
  // a player parked on a chosen frame would report itself at the start.
  const [position, setPosition] = useState(initialOffset);
  const [failed, setFailed] = useState(false);
  // Only needed when there is no `end`: the file's own length is the window.
  const [sourceDuration, setSourceDuration] = useState(0);
  const vttUrl = useVttUrl(cues);
  // The source's own shape, which decides how tall the stacked bands are.
  const [sourceRatio, setSourceRatio] = useState<number | null>(null);
  const layout = useStackLayout();
  // Only a preview is stacked or split here: a cut file already carries its layout.
  const stack = isPreview && layout?.kind === 'stacked' ? layout : null;
  const split = isPreview && layout?.kind === 'split' && splitApplies(aspectRatio) ? layout : null;
  const band = stack ? stackBandFraction(aspectRatio, sourceRatio) : 0;

  const windowEnd = end ?? sourceDuration;
  const duration = Math.max(0, windowEnd - start);

  const seekToWindowStart = useCallback(() => {
    const video = ref.current;
    if (!video) return;
    video.currentTime = start;
    setPosition(0);
  }, [start]);

  // Where the player parks when it loads: the top of the window, unless the
  // caller opened it on a particular frame.
  const seekToInitial = useCallback(() => {
    const video = ref.current;
    if (!video) return;
    const offset = Math.max(0, initialOffset);
    video.currentTime = start + offset;
    setPosition(offset);
  }, [start, initialOffset]);

  // Re-seeks whenever the window moves, so a re-run of the highlights step
  // repositions the already-mounted player instead of leaving it on the old cut.
  // It also follows `initialOffset`, which is how a frame chosen elsewhere —
  // typed, or stepped with a slider — moves the picture to match.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // Asked for straight away, so the reported position matches the frame the
    // player is meant to be on, and again once there is metadata to seek
    // against — a `currentTime` set before then does not survive the load.
    seekToInitial();
    if (video.readyState >= 1) return;
    video.addEventListener('loadedmetadata', seekToInitial, { once: true });
    return () => video.removeEventListener('loadedmetadata', seekToInitial);
  }, [src, seekToInitial]);

  // Reported from an effect rather than from the render that draws the
  // overlay: calling back into a parent while this component is rendering is
  // an update during render, which React refuses.
  useEffect(() => {
    onPositionChange?.(position);
  }, [position, onPositionChange]);


  useEffect(() => {
    if (shouldPause) ref.current?.pause();
  }, [shouldPause]);

  // `timeupdate` fires about four times a second, which is far too coarse for a
  // per-word caption: words land two or three to the second. While playing, the
  // position is read per frame instead, and only while an overlay is drawn —
  // nothing else on screen needs that resolution.
  useEffect(() => {
    if (!renderOverlay || !isPlaying) return;
    const tick = () => {
      const video = ref.current;
      if (video && !video.paused) {
        setPosition(Math.max(0, video.currentTime - start));
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [renderOverlay, isPlaying, start]);

  const handleTimeUpdate = () => {
    const video = ref.current;
    if (!video) return;
    // Out-of-window playback is snapped back rather than allowed and corrected
    // later: a frame of the neighbouring content is exactly what this is for.
    // A cut file has no neighbouring content, so it is simply left to `loop`.
    if (end !== null && (video.currentTime >= end || video.currentTime < start)) {
      seekToWindowStart();
      return;
    }
    setPosition(Math.max(0, video.currentTime - start));
  };

  const togglePlay = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) {
      // A window whose end was already reached restarts rather than sitting
      // there refusing to play.
      if (video.currentTime < start || (duration > 0 && video.currentTime >= windowEnd)) {
        seekToWindowStart();
      }
      void video.play().catch(() => setFailed(true));
    } else {
      video.pause();
    }
  };

  const scrubTo = (offset: number) => {
    const video = ref.current;
    if (!video) return;
    const bounded = clamp(offset, 0, duration);
    video.currentTime = start + bounded;
    setPosition(bounded);
  };

  const frameStyle: React.CSSProperties = {
    position: 'relative',
    backgroundColor: '#000',
    overflow: 'hidden',
    lineHeight: 0,
    ...(aspectRatio ? { aspectRatio: String(aspectRatio) } : {}),
  };

  return (
    <div>
      {/* Classed, not just styled: the clip card caps the picture by its width
          through this class, leaving the transport below at full card width. */}
      <div className="clip-media-frame" style={frameStyle}>
        <video
          ref={ref}
          src={src}
          // No `controls`: the native scrub bar spans the whole source, which
          // would defeat the window a preview exists to enforce, and a rendered
          // clip has to keep the transport its preview had.
          preload="metadata"
          playsInline
          // A cut file has nothing after it, so the browser repeats it; a
          // window inside a source is repeated by hand, at its own end.
          loop={end === null}
          aria-label={label}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={() => {
            const { videoWidth, videoHeight } = ref.current ?? {};
            if (videoWidth && videoHeight) setSourceRatio(videoWidth / videoHeight);
            const length = ref.current?.duration;
            if (typeof length === 'number' && Number.isFinite(length)) {
              setSourceDuration(length);
              // Reported even when `end` is set and this component has no use
              // for it: a caller moving the window needs the far edge, and this
              // is the only place it is known.
              onSourceDuration?.(length);
            }
          }}
          onPlay={() => {
            setIsPlaying(true);
            onPlay?.();
          }}
          onPause={() => {
            setIsPlaying(false);
            onPause?.();
          }}
          // Scrubbing while paused still has to move the captions with the frame.
          onSeeked={() => setPosition(Math.max(0, (ref.current?.currentTime ?? start) - start))}
          // `end` can sit past the real duration if the model over-ran; the
          // source ending is then the window ending.
          onEnded={seekToWindowStart}
          onError={() => setFailed(true)}
          onClick={togglePlay}
          style={
            band > 0
              ? {
                  // Stacked: the whole frame, between the bands drawn below.
                  position: 'absolute',
                  left: 0,
                  top: `${band * 100}%`,
                  width: '100%',
                  height: `${(1 - 2 * band) * 100}%`,
                  objectFit: 'contain',
                  display: 'block',
                  cursor: 'pointer',
                }
              : {
                  width: '100%',
                  height: aspectRatio ? '100%' : 'auto',
                  // A preview fills the target frame the way the render's
                  // crop-then-scale does, rather than letterboxing into it. A cut
                  // file is shown whole: if it does not match the ratio now set on
                  // the project, that mismatch is the truth about the file.
                  objectFit: aspectRatio && isPreview ? 'cover' : 'contain',
                  display: 'block',
                  cursor: 'pointer',
                }
          }
        >
          {/* Not `default` — captions may already be in the frames, and where
              they are not the overlay is drawing them; either way switching
              this on would stack a second copy over them. It exists so the
              words reach assistive technology and the browser's own caption
              menu, which painted pixels cannot. */}
          {vttUrl && <track kind="captions" srcLang="en" label="Captions" src={vttUrl} />}
        </video>
        {band > 0 && stack && <StackedBands video={ref} band={band} darkness={stack.darkness} />}
        {/* Over the video rather than instead of it: the halves are painted
            from it, and clicks pass through them to it. */}
        {split && <SplitHalves video={ref} position={split.position} swap={split.swap} divider={split.divider} />}
        {/* Inside the frame, so the captions sit where the render puts them
            rather than where the video element happens to end. */}
        {renderOverlay?.(position, isPlaying)}
      </div>

      {failed ? (
        <p role="alert" style={{ margin: 0, padding: 'var(--space-sm)', fontSize: '0.75rem', color: 'var(--error)' }}>
          {isPreview
            ? 'The source video could not be played, so this clip cannot be previewed.'
            : 'This clip could not be played.'}
        </p>
      ) : (
        <div
          className="clip-transport"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            padding: 'var(--space-sm)',
            borderTop: '2px solid var(--border-color)',
            backgroundColor: 'var(--bg)',
          }}
        >
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
            style={{
              minWidth: '44px',
              minHeight: '44px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              {isPlaying ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M6 4l14 8-14 8z" />}
            </svg>
          </button>

          <input
            type="range"
            min={0}
            max={duration || 0.01}
            step={0.05}
            value={Math.min(position, duration)}
            onChange={(event) => scrubTo(Number(event.target.value))}
            aria-label={`Position within ${label}`}
            aria-valuetext={`${formatTimecode(position)} of ${formatTimecode(duration)}`}
            className="clip-transport__scrub"
            style={{ flex: 1, minWidth: 0, accentColor: 'var(--accent)', cursor: 'pointer' }}
          />

          {/* The source timecode is what you need to find this moment in an
              editor, so it is shown alongside the position within the window. */}
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatTimecode(position)} / {formatTimecode(duration)}
          </span>
        </div>
      )}
    </div>
  );
};
