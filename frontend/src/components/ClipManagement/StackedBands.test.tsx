import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ClipPlayer } from './ClipPlayer';
import { StackLayoutContext, stackBandFraction, stackLayoutFor } from './StackedBands';

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
});

const renderPlayer = (
  layout: { layout?: string; stack_darkness?: number; split_divider?: boolean },
  isPreview = true,
  aspectRatio = 9 / 16
) => {
  const result = render(
    <StackLayoutContext.Provider value={stackLayoutFor(layout)}>
      <ClipPlayer src="/original.mp4" start={0} end={10} aspectRatio={aspectRatio} isPreview={isPreview} label="a clip" />
    </StackLayoutContext.Provider>
  );
  fireEvent.loadedMetadata(document.querySelector('video') as HTMLVideoElement);
  return result;
};

describe('stacked preview', () => {
  it('splits a 9:16 frame of 16:9 footage into the bands the render draws', () => {
    // The middle is 9/16 ÷ 16/9 of the height, the bands share the rest.
    expect(stackBandFraction(9 / 16, 16 / 9)).toBeCloseTo((1 - 81 / 256) / 2);
  });

  it('has no bands when the frame is no taller than the source', () => {
    expect(stackBandFraction(16 / 9, 16 / 9)).toBe(0);
    expect(stackBandFraction(null, 16 / 9)).toBe(0);
  });

  it('draws the whole frame between two bands when the project stacks', () => {
    const { container } = renderPlayer({ layout: 'stacked' });

    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.style.objectFit).toBe('contain');
    expect(parseFloat(video.style.top)).toBeCloseTo(((1 - 81 / 256) / 2) * 100);
  });

  it('crops as before when the project crops', () => {
    const { container } = renderPlayer({ layout: 'crop' });

    expect(container.querySelectorAll('canvas')).toHaveLength(0);
    expect((container.querySelector('video') as HTMLVideoElement).style.objectFit).toBe('cover');
  });

  it('leaves a cut file alone, which already carries its bands', () => {
    const { container } = renderPlayer({ layout: 'stacked' }, false);

    expect(container.querySelectorAll('canvas')).toHaveLength(0);
  });
});

describe('split preview', () => {
  it('reads the split settings, clamping the position', () => {
    expect(stackLayoutFor({ layout: 'split', split_position: 95, split_swap: true })).toEqual({
      kind: 'split', position: 0.8, swap: true, divider: false,
    });
  });

  it('covers the frame with two halves when the project splits', () => {
    const { container } = renderPlayer({ layout: 'split' });

    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    canvases.forEach((canvas) => expect(canvas.style.height).toBe('50%'));
  });

  it('draws the divider only when asked', () => {
    expect(renderPlayer({ layout: 'split' }).container.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
    expect(
      renderPlayer({ layout: 'split', split_divider: true }).container.querySelectorAll('div[aria-hidden="true"]')
    ).toHaveLength(1);
  });

  it('crops a frame that is not portrait, like the render', () => {
    const { container } = renderPlayer({ layout: 'split' }, true, 1);

    expect(container.querySelectorAll('canvas')).toHaveLength(0);
  });
});
