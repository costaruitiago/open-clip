import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { OverlayTextEditor } from './OverlayTextEditor';
import { stubFrameSize } from '../../test/stubFrame';
import { DEFAULT_OVERLAY_TEXT, updateClipOverlay, type OverlayText } from '../../api';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  updateClipOverlay: vi.fn().mockResolvedValue({ status: 'success', overlay: null }),
}));

beforeEach(() => {
  vi.mocked(updateClipOverlay).mockClear();
  stubFrameSize(400);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

/**
 * The dialog with the page's half of the contract around it: the draft lives
 * above it, which is what lets the picture behind redraw per keystroke.
 */
let client: QueryClient;

const Harness: React.FC<{ onClose?: () => void }> = ({ onClose = () => {} }) => {
  const [draft, setDraft] = useState<OverlayText | null>(null);
  return (
    <QueryClientProvider client={client}>
      <OverlayTextEditor
        projectId="test-project"
        clipIndex={0}
        isOpen
        onClose={onClose}
        value={draft ?? DEFAULT_OVERLAY_TEXT}
        onChange={setDraft}
      />
    </QueryClientProvider>
  );
};

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: text } });

describe('OverlayTextEditor', () => {
  // Saving is debounced, and a debounce is a timer nobody is obliged to wait
  // for: a card unmounted on its way out — scrolled away, or the grid rebuilt
  // by a poll — takes the pending save with it. Leaving on purpose therefore
  // sends immediately rather than arming another timer.
  it('sends a title typed and closed straight away, without waiting out the debounce', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      type('Cold open');
      fireEvent.click(screen.getByRole('button', { name: 'Save and close' }));

      // Zero, which lets the mutation's own microtasks run but leaves the 300ms
      // debounce timer unfired: what arrives here is the flush.
      await vi.advanceTimersByTimeAsync(0);
      expect(updateClipOverlay).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateClipOverlay).mock.calls[0][2]).toMatchObject({ text: 'Cold open' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the dialog once it has sent it', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    type('Cold open');
    fireEvent.click(screen.getByRole('button', { name: 'Save and close' }));

    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(updateClipOverlay).toHaveBeenCalledTimes(1));
  });

  // Every way out is the same handler, so dismissing the dialog is not a way to
  // lose the last thing typed into it.
  it('sends it when the dialog is dismissed rather than saved', async () => {
    render(<Harness />);
    type('Cold open');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(updateClipOverlay).toHaveBeenCalledTimes(1));
  });

  // Null is the lock rather than a delete: the clip stops speaking for itself
  // and is left with the project's configuration, which carries no words.
  it('takes the title off the clip rather than saving the edit on its way out', async () => {
    render(<Harness />);
    type('Cold open');
    fireEvent.click(screen.getByRole('button', { name: 'Remove this title' }));

    await waitFor(() => expect(updateClipOverlay).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateClipOverlay).mock.calls[0][2]).toBeNull();
  });

  describe('while it is following the project', () => {
    const Locked: React.FC = () => {
      const [draft, setDraft] = useState<OverlayText | null>(null);
      return (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <OverlayTextEditor
            projectId="test-project"
            clipIndex={0}
            isOpen
            isLocked
            onClose={() => {}}
            value={draft ?? { ...DEFAULT_OVERLAY_TEXT, text: 'Series name' }}
            onChange={setDraft}
          />
        </QueryClientProvider>
      );
    };

    it('shows the inherited title without letting it be edited', () => {
      render(<Locked />);

      expect(screen.getByLabelText('Text')).toHaveValue('Series name');
      expect(screen.getByLabelText('Text')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save and close' })).not.toBeInTheDocument();
    });

    // Unlocking is a promise about nothing changing until the user changes it,
    // so the clip is handed exactly what it was already drawing.
    it('copies what it inherits onto the clip when it is unlocked', async () => {
      render(<Locked />);
      fireEvent.click(screen.getByRole('button', { name: 'Give this clip its own title' }));

      await waitFor(() => expect(updateClipOverlay).toHaveBeenCalledTimes(1));
      expect(vi.mocked(updateClipOverlay).mock.calls[0][2]).toMatchObject({ text: 'Series name' });
      expect(screen.getByLabelText('Text')).not.toBeDisabled();
    });
  });


  it('debounces typing into one request rather than one per keystroke', async () => {
    render(<Harness />);
    type('C');
    type('Co');
    type('Cold open');
    fireEvent.click(screen.getByRole('button', { name: 'Save and close' }));

    await waitFor(() => expect(updateClipOverlay).toHaveBeenCalledTimes(1));
  });

  it('places the title against a picture when one is given to it', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OverlayTextEditor
          projectId="test-project"
          clipIndex={0}
          isOpen
          onClose={() => {}}
          value={{ ...DEFAULT_OVERLAY_TEXT, text: 'Cold open' }}
          onChange={() => {}}
          preview={{
            src: 'http://localhost:8000/clip.mp4',
            start: 0,
            end: null,
            isPreview: false,
            aspectRatio: 9 / 16,
            label: 'Clip 1',
          }}
        />
      </QueryClientProvider>
    );

    expect(document.querySelector('video')?.getAttribute('src')).toBe('http://localhost:8000/clip.mp4');
    // Drawn on the picture, and in the textarea: two of them, not one.
    expect(screen.getAllByText('Cold open').length).toBeGreaterThan(0);
  });

  // A preset is a whole contrast decision, not a colour: half of one applied
  // over half of the last is how a title ends up unreadable.
  it('applies a preset as one group rather than a colour at a time', async () => {
    render(<Harness />);
    type('Cold open');

    fireEvent.click(screen.getByRole('button', { name: 'Yellow on black' }));

    await waitFor(() => expect(updateClipOverlay).toHaveBeenCalled());
    const sent = vi.mocked(updateClipOverlay).mock.calls.at(-1)?.[2];
    expect(sent).toMatchObject({
      text_color: '#FFE000',
      box_color: '#000000E6',
      highlight_color: '#FFFFFF',
    });
  });

  // The one test the whole craft comes down to: if the words do not land at
  // the width a phone feed gives them, nobody scrolling reads them.
  it('shrinks the preview to what a phone feed shows, and back', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OverlayTextEditor
          projectId="test-project"
          clipIndex={0}
          isOpen
          onClose={() => {}}
          value={{ ...DEFAULT_OVERLAY_TEXT, text: 'Cold open' }}
          onChange={() => {}}
          preview={{
            src: 'http://localhost:8000/clip.mp4',
            start: 0,
            end: null,
            isPreview: false,
            aspectRatio: 9 / 16,
            label: 'Clip 1',
          }}
        />
      </QueryClientProvider>
    );

    const frame = () => document.querySelector('video')?.closest('div')?.parentElement?.parentElement;
    fireEvent.click(screen.getByRole('button', { name: /feed size/i }));
    expect(screen.getByRole('button', { name: /back to full size/i })).toHaveAttribute('aria-pressed', 'true');
    expect(frame()?.style.maxWidth).toBe('120px');

    fireEvent.click(screen.getByRole('button', { name: /back to full size/i }));
    expect(frame()?.style.maxWidth).not.toBe('120px');
  });

  it('says when a title has grown past what a thumbnail can carry', () => {
    render(<Harness />);

    type('one two three');
    expect(screen.getByText(/^3 words, longest line 13 characters$/)).toBeDefined();

    type('one two three four five six');
    expect(screen.getByText(/Three to five words is what gets clicked/)).toBeDefined();
  });

  it('does not count the marks as something anyone reads', () => {
    render(<Harness />);

    type('we *lost* it');

    // Three words and ten characters: the asterisks are instructions.
    expect(screen.getByText(/^3 words, longest line 10 characters$/)).toBeDefined();
  });
});
