import React, { createContext, useContext, useEffect, useRef } from 'react';

/**
 * The project's stacked or split layout, or null when it crops.
 *
 * Provided once per page rather than passed down: every player and still that
 * previews from the source has to draw the same layout, and they sit several
 * components deep in editors that otherwise know nothing about it.
 */
export type StackLayout =
  | { kind: 'stacked'; darkness: number }
  | { kind: 'split'; position: number; swap: boolean; divider: boolean }
  | null;

export const StackLayoutContext = createContext<StackLayout>(null);

export const useStackLayout = () => useContext(StackLayoutContext);

/** The layout a project's settings describe. */
export const stackLayoutFor = (
  settings:
    | { layout?: string; stack_darkness?: number; split_position?: number; split_swap?: boolean; split_divider?: boolean }
    | undefined
): StackLayout => {
  if (settings?.layout === 'stacked') {
    return { kind: 'stacked', darkness: Math.min(100, Math.max(0, settings.stack_darkness ?? 50)) / 100 };
  }
  if (settings?.layout === 'split') {
    return {
      kind: 'split',
      position: Math.min(80, Math.max(20, settings.split_position ?? 50)) / 100,
      swap: settings.split_swap === true,
      divider: settings.split_divider === true,
    };
  }
  return null;
};

/**
 * How much of the frame's height each band takes, or 0 when the frame is no
 * taller than the source scaled to its width — the render crops then, so the
 * preview must too. Mirrors `build_picture_args` on the backend.
 */
export const stackBandFraction = (frameRatio: number | null, sourceRatio: number | null): number => {
  if (!frameRatio || !sourceRatio) return 0;
  const band = (1 - frameRatio / sourceRatio) / 2;
  return band > 0 ? band : 0;
};

/** Whether the render splits a frame of this shape, or crops it instead. Mirrors `build_picture_args`. */
export const splitApplies = (frameRatio: number | null): boolean => !!frameRatio && frameRatio < 1;

/**
 * Draws `sx, sy, sw, sh` of the source cover-cropped around its centre into
 * the whole canvas, the way the render crops each band or half.
 */
const drawCovered = (
  canvas: HTMLCanvasElement,
  source: HTMLVideoElement,
  sx: number,
  sw: number
): CanvasRenderingContext2D | null => {
  const ratio = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const ch = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const vh = source.videoHeight;
  const target = cw / ch;
  const w = sw / vh > target ? vh * target : sw;
  const h = sw / vh > target ? vh : sw / target;
  context.drawImage(source, sx + (sw - w) / 2, (vh - h) / 2, w, h, 0, 0, cw, ch);
  return context;
};

/**
 * Repaints from the one <video> already playing rather than from more: several
 * decoders on one source drift apart, and a band a frame behind the rest is
 * exactly what the render will never produce.
 */
const useVideoPainter = (
  video: React.RefObject<HTMLVideoElement | null>,
  paint: (source: HTMLVideoElement) => void,
  deps: React.DependencyList
) => {
  useEffect(() => {
    const source = video.current;
    if (!source) return;
    let frame: number | null = null;

    const repaint = () => {
      if (source.videoWidth && source.videoHeight) paint(source);
    };
    const loop = () => {
      repaint();
      frame = source.paused ? null : requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame === null) frame = requestAnimationFrame(loop);
    };

    const events = ['loadeddata', 'seeked', 'timeupdate'] as const;
    events.forEach((name) => source.addEventListener(name, repaint));
    source.addEventListener('play', start);
    repaint();
    if (!source.paused) start();

    return () => {
      events.forEach((name) => source.removeEventListener(name, repaint));
      source.removeEventListener('play', start);
      if (frame !== null) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, ...deps]);
};

const canvasStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  width: '100%',
  display: 'block',
  pointerEvents: 'none',
};

interface StackedBandsProps {
  video: React.RefObject<HTMLVideoElement | null>;
  /** Each band's share of the frame height. */
  band: number;
  /** 0 leaves the bands untouched, 1 is black. */
  darkness: number;
}

/** The darkened copies above and below the full frame, as the render stacks them. */
export const StackedBands: React.FC<StackedBandsProps> = ({ video, band, darkness }) => {
  const topRef = useRef<HTMLCanvasElement>(null);
  const bottomRef = useRef<HTMLCanvasElement>(null);

  useVideoPainter(
    video,
    (source) => {
      for (const canvas of [topRef.current, bottomRef.current]) {
        if (!canvas) continue;
        const context = drawCovered(canvas, source, 0, source.videoWidth);
        if (!context) continue;
        context.fillStyle = `rgba(0, 0, 0, ${darkness})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
    },
    [band, darkness]
  );

  const bandStyle: React.CSSProperties = { ...canvasStyle, height: `${band * 100}%` };

  return (
    <>
      <canvas ref={topRef} aria-hidden="true" style={{ ...bandStyle, top: 0 }} />
      <canvas ref={bottomRef} aria-hidden="true" style={{ ...bandStyle, bottom: 0 }} />
    </>
  );
};

interface SplitHalvesProps {
  video: React.RefObject<HTMLVideoElement | null>;
  /** Where the source is cut, as a share of its width from the left. */
  position: number;
  /** The right part on top instead of the left. */
  swap: boolean;
  /** A line along the seam. */
  divider: boolean;
}

/**
 * The source cut at `position` into a left and a right part, one above the
 * other, covering the whole frame the way the render splits it.
 */
export const SplitHalves: React.FC<SplitHalvesProps> = ({ video, position, swap, divider }) => {
  const topRef = useRef<HTMLCanvasElement>(null);
  const bottomRef = useRef<HTMLCanvasElement>(null);

  useVideoPainter(
    video,
    (source) => {
      const cut = source.videoWidth * position;
      const parts: [number, number][] = [[0, cut], [cut, source.videoWidth - cut]];
      if (swap) parts.reverse();
      [topRef.current, bottomRef.current].forEach((canvas, i) => {
        if (canvas) drawCovered(canvas, source, parts[i][0], parts[i][1]);
      });
    },
    [position, swap]
  );

  const halfStyle: React.CSSProperties = { ...canvasStyle, height: '50%' };

  return (
    <>
      <canvas ref={topRef} aria-hidden="true" style={{ ...halfStyle, top: 0 }} />
      <canvas ref={bottomRef} aria-hidden="true" style={{ ...halfStyle, bottom: 0 }} />
      {divider && (
        // 1/240 of the height, like the render's line.
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            width: '100%',
            top: 'calc(50% - 0.2083%)',
            height: 'max(1px, 0.4167%)',
            backgroundColor: '#fff',
            pointerEvents: 'none',
          }}
        />
      )}
    </>
  );
};
