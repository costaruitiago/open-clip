import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { TextOverlay } from './TextOverlay';
import { stubFrameSize } from '../../test/stubFrame';
import { DEFAULT_OVERLAY_TEXT, type OverlayText } from '../../api';

const TITLE: OverlayText = {
  ...DEFAULT_OVERLAY_TEXT,
  text: 'Cold open',
  start: 0,
  duration: 3,
  fade_in: 0.3,
  fade_out: 0.6,
};

// 400px stands in for the rendered preview box; the overlay sizes everything
// from it.
beforeAll(() => stubFrameSize(400));

// The block carrying the fade, one level above the span holding the text.
const block = () => screen.getByText('Cold open').parentElement;

describe('TextOverlay', () => {
  it('ramps the fade in while the clip is playing', () => {
    render(<TextOverlay overlay={TITLE} time={0.15} />);
    // Halfway through a 0.3s fade.
    expect(block()).toHaveStyle({ opacity: '0.5' });
  });

  it('ramps the fade out at the end of the window', () => {
    render(<TextOverlay overlay={TITLE} time={2.7} />);
    // 0.3s of a 0.6s fade-out left. Compared numerically: the ramp is float
    // arithmetic on the playhead, so the exact string is noise.
    expect(Number(block()?.style.opacity)).toBeCloseTo(0.5);
  });

  // The bug this exists for: a paused player sits on the first frame, which is
  // the exact moment the fade-in has ramped to nothing. A saved title drawn at
  // zero opacity is indistinguishable from one that never saved.
  it('draws a stopped picture solid rather than at the start of its fade', () => {
    render(<TextOverlay overlay={TITLE} time={0} still />);
    expect(block()).toHaveStyle({ opacity: '1' });
  });

  it('still draws nothing when the stopped picture is outside the window', () => {
    render(<TextOverlay overlay={TITLE} time={9} still />);
    expect(screen.queryByText('Cold open')).not.toBeInTheDocument();
  });

  // A title a user has not configured a fade for is simply there, playing or
  // not, from the first frame of the clip.
  it('draws a default title solid from the first frame, playing', () => {
    render(<TextOverlay overlay={{ ...DEFAULT_OVERLAY_TEXT, text: 'Cold open' }} time={0} />);
    expect(block()).toHaveStyle({ opacity: '1' });
  });

  it('draws nothing before the title is due', () => {
    render(<TextOverlay overlay={{ ...TITLE, start: 4 }} time={0} />);
    expect(screen.queryByText('Cold open')).not.toBeInTheDocument();
  });

  // What the editor needs: a title being typed has to be on screen even at the
  // frame its own fade starts from.
  it('shows the title regardless of the playhead when asked to', () => {
    render(<TextOverlay overlay={{ ...TITLE, start: 4 }} time={0} forceVisible />);
    expect(block()).toHaveStyle({ opacity: '1' });
  });

  it('anchors the title to the top of the frame, where the burn puts it', () => {
    render(<TextOverlay overlay={{ ...TITLE, position_pct: 12 }} time={0} still />);
    expect(block()).toHaveStyle({ top: '12%' });
  });

  it('sizes the text as a percentage of the frame, not in fixed pixels', () => {
    render(<TextOverlay overlay={{ ...TITLE, font_size_pct: 8 }} time={0} still />);
    // 8% of the 400px frame.
    expect(block()).toHaveStyle({ fontSize: '32px' });
  });

  // The lift the burn draws with ASS `Shadow`.
  it('offsets a hard shadow by a percentage of the frame', () => {
    render(<TextOverlay overlay={{ ...TITLE, shadow_pct: 1, shadow_color: '#000000' }} time={0} still />);
    // 1% of the 400px frame, down and right, with no blur radius.
    expect(block()?.style.textShadow).toContain('4px 4px 0');
  });

  it('draws no shadow at all when it is turned off', () => {
    render(<TextOverlay overlay={{ ...TITLE, shadow_pct: 0 }} time={0} still />);
    expect(block()?.style.textShadow).toBe('');
  });

  // libass with `BorderStyle: 3` offsets the block rather than the glyphs, so
  // the preview has to move the same thing or the two disagree.
  it('shadows the block instead of the glyphs when the title has a box', () => {
    render(
      <TextOverlay
        overlay={{ ...TITLE, shadow_pct: 1, box_color: '#000000CC' }}
        time={0}
        still
      />
    );
    expect(block()?.style.textShadow).toBe('');
    expect(screen.getByText('Cold open').style.boxShadow).toContain('4px 4px 0');
  });

  // One word in a second colour is what a thumbnail that gets clicked does.
  it('draws a marked word in the highlight colour', () => {
    render(
      <TextOverlay
        overlay={{ ...TITLE, text: 'we *lost* it', highlight_color: '#FFE000' }}
        time={0}
        still
      />
    );
    expect(screen.getByText('lost')).toHaveStyle({ color: '#FFE000' });
  });

  it('keeps the marks out of the drawn text', () => {
    const { container } = render(
      <TextOverlay overlay={{ ...TITLE, text: 'we *lost* it' }} time={0} still />
    );
    expect(container.textContent).toBe('we lost it');
  });

  // A title can legitimately contain an asterisk, and eating it would draw a
  // title the user did not write.
  it('leaves a lone asterisk in the text', () => {
    const { container } = render(
      <TextOverlay overlay={{ ...TITLE, text: 'rated 5*' }} time={0} still />
    );
    expect(container.textContent).toBe('rated 5*');
  });

  // libass wraps at spaces and cannot break inside a word, so a word wider
  // than the frame is not wrapped — it is drawn past the edge and cut off.
  // The preview draws with the same face, so it is the thing that can tell.
  it('reports a word the burn would cut off', () => {
    const onOverflow = vi.fn();
    // jsdom lays nothing out, so both widths have to be stated.
    const widths = (scrollWidth: number) => {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scrollWidth });
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    };

    try {
      widths(500);
      render(<TextOverlay overlay={{ ...TITLE, text: 'EVERYTHING' }} time={0} still onOverflow={onOverflow} />);
      expect(onOverflow).toHaveBeenLastCalledWith(true);

      widths(280);
      render(<TextOverlay overlay={{ ...TITLE, text: 'WE LOST' }} time={0} still onOverflow={onOverflow} />);
      expect(onOverflow).toHaveBeenLastCalledWith(false);
    } finally {
      // Through an index signature rather than through the DOM type: both
      // properties are readonly on HTMLElement, and `Partial<HTMLElement>`
      // keeps that, so the delete would not typecheck. What is being removed
      // is the stub defined above, not the real accessor.
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      delete proto.scrollWidth;
      delete proto.clientWidth;
    }
  });

  it('is hidden from assistive technology, which reads the clip text instead', () => {
    const { container } = render(<TextOverlay overlay={TITLE} time={0} still />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
