import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ClipPlayer } from './ClipPlayer';
import { StackLayoutContext, stackBandFraction, stackLayoutFor } from './StackedBands';

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
});

const renderPlayer = (layout: { layout?: string; stack_darkness?: number }, isPreview = true) => {
  const result = render(
    <StackLayoutContext.Provider value={stackLayoutFor(layout)}>
      <ClipPlayer src="/original.mp4" start={0} end={10} aspectRatio={9 / 16} isPreview={isPreview} label="a clip" />
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
