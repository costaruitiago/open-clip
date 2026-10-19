import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClipTrimmer, MIN_CLIP_DURATION } from './ClipTrimmer';
import { stubFrameSize } from '../../test/stubFrame';
import { updateClipTrim } from '../../api';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  updateClipTrim: vi
    .fn()
    .mockResolvedValue({ status: 'success', start: 0, end: 0, trimmed_at: 'now' }),
}));

let client: QueryClient;

beforeEach(() => {
  vi.mocked(updateClipTrim).mockClear();
  stubFrameSize(400);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const renderTrimmer = (props: Partial<React.ComponentProps<typeof ClipTrimmer>> = {}) =>
  render(
    <QueryClientProvider client={client}>
      <ClipTrimmer
        projectId="test-project"
        clipIndex={0}
        isOpen
        onClose={() => {}}
        start={10}
        end={30}
        sourceUrl="http://example.test/source.mp4"
        aspectRatio={9 / 16}
        label="Clip 1"
        {...props}
      />
    </QueryClientProvider>
  );

const startField = () => screen.getByLabelText(/Starts at/) as HTMLInputElement;
const endField = () => screen.getByLabelText(/Ends at/) as HTMLInputElement;

/** Moves the player's own transport, in seconds from the top of what it plays. */
const scrubTo = (seconds: number) =>
  fireEvent.change(screen.getByLabelText('Position within Clip 1'), {
    target: { value: String(seconds) },
  });

describe('ClipTrimmer', () => {
  it('opens on the window as stored', () => {
    renderTrimmer();

    expect(startField().value).toBe('10');
    expect(endField().value).toBe('30');
  });

  // The whole point of the feature: an edge that is a second or two off.
  it('nudges the start later without moving the end', () => {
    renderTrimmer();

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds later' }));

    expect(startField().value).toBe('11');
    expect(endField().value).toBe('30');
  });

  it('nudges the end earlier without moving the start', () => {
    renderTrimmer();

    fireEvent.click(screen.getByRole('button', { name: 'Move the end of the clip 1 seconds earlier' }));

    expect(startField().value).toBe('10');
    expect(endField().value).toBe('29');
  });

  // The point of having a player at all: scrub to the frame the clip should
  // open on, and say so in one press rather than reading the timecode off and
  // typing it back in.
  it('starts the clip at the frame the player is parked on', () => {
    renderTrimmer();

    scrubTo(5);
    fireEvent.click(screen.getByRole('button', { name: /Start the clip at the frame/ }));

    // Five seconds into a window that opens at ten.
    expect(startField().value).toBe('15');
    expect(endField().value).toBe('30');
  });

  it('ends the clip at the frame the player is parked on', () => {
    renderTrimmer();

    scrubTo(12);
    fireEvent.click(screen.getByRole('button', { name: /End the clip at the frame/ }));

    expect(endField().value).toBe('22');
    expect(startField().value).toBe('10');
  });

  // Marking is refused rather than clamped: an edge that lands somewhere the
  // user can see they did not point at is worse than a button that waits.
  it('will not mark an out point behind the in point', () => {
    renderTrimmer();

    scrubTo(0);

    expect(screen.getByRole('button', { name: /End the clip at the frame/ })).toBeDisabled();
  });

  it('will not mark an in point past the out point', () => {
    renderTrimmer();

    scrubTo(20);

    expect(screen.getByRole('button', { name: /Start the clip at the frame/ })).toBeDisabled();
  });

  // Held to the clip's own window there is nothing before the in point to
  // scrub to, so marking could only ever move an edge inwards.
  it('reaches outside the clip when asked, so an edge can be marked earlier', () => {
    renderTrimmer();

    fireEvent.click(screen.getByLabelText(/Play 5s either side/));
    // Position zero is now five seconds before the clip opens.
    scrubTo(0);
    fireEvent.click(screen.getByRole('button', { name: /Start the clip at the frame/ }));

    expect(startField().value).toBe('5');
  });

  it('takes a typed number for either edge', () => {
    renderTrimmer();

    fireEvent.change(startField(), { target: { value: '12.4' } });

    expect(startField().value).toBe('12.4');
  });

  // The source starts where it starts; a nudge past that is a nudge into
  // nothing, and ffmpeg would silently cut from zero anyway.
  it('will not pull the start before the beginning of the source', () => {
    renderTrimmer({ start: 0.4, end: 20 });

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds earlier' }));

    expect(startField().value).toBe('0');
  });

  // The backend refuses this too. Refusing it here as well is what keeps the
  // user from having to read an error to find out.
  it('will not close the window past the shortest clip worth cutting', () => {
    renderTrimmer({ start: 10, end: 10 + MIN_CLIP_DURATION });

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds later' }));

    expect(startField().value).toBe('10');
  });

  it('saves the whole window rather than a delta', async () => {
    renderTrimmer();

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save trim' }));

    await waitFor(() => expect(updateClipTrim).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateClipTrim).mock.calls[0][2]).toEqual({ start: 11, end: 30 });
  });

  it('has nothing to save until an edge has moved', () => {
    renderTrimmer();

    expect(screen.getByRole('button', { name: 'Save trim' })).toBeDisabled();
  });

  it('puts the draft back where it was stored', () => {
    renderTrimmer();

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(startField().value).toBe('10');
    expect(updateClipTrim).not.toHaveBeenCalled();
  });

  // Clips are cut on their way out, never from here.
  it('does not offer a re-cut', () => {
    renderTrimmer();

    expect(screen.queryByRole('button', { name: 'Save and re-cut' })).toBeNull();
  });

  it('says so rather than showing an empty frame when the source is gone', () => {
    renderTrimmer({ sourceUrl: null });

    expect(screen.getByText(/source video is gone/i)).toBeInTheDocument();
    // The numbers are still editable: they describe the next render, which does
    // not depend on the browser being able to play anything.
    expect(startField().value).toBe('10');
  });

  it('reports a refused save instead of looking like it worked', async () => {
    vi.mocked(updateClipTrim).mockRejectedValueOnce(new Error('A clip has to be at least 0.5 seconds long.'));
    renderTrimmer();

    fireEvent.click(screen.getByRole('button', { name: 'Move the start of the clip 1 seconds later' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save trim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at least 0.5 seconds');
  });
});
