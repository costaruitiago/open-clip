import React, { createContext, useContext, useEffect, useRef } from 'react';

/**
 * The project's stacked layout, or null when it crops.
 *
 * Provided once per page rather than passed down: every player and still that
 * previews from the source has to draw the same layout, and they sit several
 * components deep in editors that otherwise know nothing about it.
 */
export type StackLayout = { darkness: number } | null;

export const StackLayoutContext = createContext<StackLayout>(null);

export const useStackLayout = () => useContext(StackLayoutContext);

/** The layout a project's settings describe. */
export const stackLayoutFor = (
  settings: { layout?: string; stack_darkness?: number } | undefined
): StackLayout =>
  settings?.layout === 'stacked'
    ? { darkness: Math.min(100, Math.max(0, settings.stack_darkness ?? 50)) / 100 }
    : null;

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

interface StackedBandsProps {
  video: React.RefObject<HTMLVideoElement | null>;
  /** Each band's share of the frame height. */
  band: number;
  /** 0 leaves the bands untouched, 1 is black. */
  darkness: number;
}

/**
 * The darkened copies above and below the full frame, as the render stacks them.
 *
 * Painted from the one <video> already playing rather than from two more: three
 * decoders on one source drift apart, and a band a frame behind the middle is
 * exactly what the render will never produce.
 */
export const StackedBands: React.FC<StackedBandsProps> = ({ video, band, darkness }) => {
  const topRef = useRef<HTMLCanvasElement>(null);
  const bottomRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const source = video.current;
    if (!source) return;
    let frame: number | null = null;

    const paint = () => {
      const vw = source.videoWidth;
      const vh = source.videoHeight;
      if (!vw || !vh) return;
      for (const canvas of [topRef.current, bottomRef.current]) {
        if (!canvas) continue;
        const ratio = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const ch = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
        const context = canvas.getContext('2d');
        if (!context) continue;
        // Cover-cropped around the centre, the way the render crops each band.
        const target = cw / ch;
        const sw = vw / vh > target ? vh * target : vw;
        const sh = vw / vh > target ? vh : vw / target;
        context.drawImage(source, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, ch);
        context.fillStyle = `rgba(0, 0, 0, ${darkness})`;
        context.fillRect(0, 0, cw, ch);
      }
    };

    const loop = () => {
      paint();
      frame = source.paused ? null : requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame === null) frame = requestAnimationFrame(loop);
    };

    const events = ['loadeddata', 'seeked', 'timeupdate'] as const;
    events.forEach((name) => source.addEventListener(name, paint));
    source.addEventListener('play', start);
    paint();
    if (!source.paused) start();

    return () => {
      events.forEach((name) => source.removeEventListener(name, paint));
      source.removeEventListener('play', start);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [video, band, darkness]);

  const bandStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    width: '100%',
    height: `${band * 100}%`,
    display: 'block',
    pointerEvents: 'none',
  };

  return (
    <>
      <canvas ref={topRef} aria-hidden="true" style={{ ...bandStyle, top: 0 }} />
      <canvas ref={bottomRef} aria-hidden="true" style={{ ...bandStyle, bottom: 0 }} />
    </>
  );
};
