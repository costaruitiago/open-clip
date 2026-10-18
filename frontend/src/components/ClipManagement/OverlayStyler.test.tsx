import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OverlayStyler } from './OverlayStyler';
import { DEFAULT_OVERLAY_TEXT, updateProjectSettings, type OverlayText } from '../../api';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  updateProjectSettings: vi.fn().mockResolvedValue({ status: 'success' }),
}));

beforeEach(() => vi.mocked(updateProjectSettings).mockClear());

let client: QueryClient;

const renderStyler = (overlay?: OverlayText) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OverlayStyler projectId="test-project" overlay={overlay} />
    </QueryClientProvider>
  );
};

const open = () => fireEvent.click(screen.getByRole('button', { name: /Overlay titles/ }));

const drag = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('OverlayStyler', () => {
  // A project written before the setting existed carries nothing, and the
  // controls have to open on something rather than on undefined.
  it('opens on the defaults for a project that has never set one', () => {
    renderStyler(undefined);
    open();

    expect(screen.getByLabelText(/Burn titles/)).not.toBeChecked();
    expect(screen.getByLabelText(/^Size/)).toHaveValue('8');
  });

  // The words are the one thing about a title that cannot be the same on every
  // short. A line stored here would be one line over the whole project.
  it('has nowhere to type a title', () => {
    renderStyler(undefined);
    open();

    expect(screen.queryByLabelText('Text')).not.toBeInTheDocument();
  });

  it('writes a change to the project rather than holding it in the page', async () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: false, text: '' });
    open();
    drag(/^Position/, '40');

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateProjectSettings).mock.calls[0][1]).toMatchObject({
      overlay: expect.objectContaining({ position_pct: 40 }),
    });
  });

  // The object the controls edit still carries the field, so it has to be held
  // empty on the way out or a stale line would reach the project.
  it('never sends text, whatever the stored settings carry', async () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: true, text: 'Left over' });
    open();
    drag(/^Position/, '40');

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateProjectSettings).mock.calls[0][1]).toMatchObject({
      overlay: expect.objectContaining({ text: '' }),
    });
  });

  // The one thing worth knowing from outside the dialog is whether titles reach
  // the video at all.
  it('says on the trigger whether titles are burned in', () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: true, text: '' });

    expect(screen.getByRole('button', { name: /Overlay titles/ })).toHaveTextContent('On');
  });

  it('says so when they are switched off', () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: false, text: '' });

    expect(screen.getByRole('button', { name: /Overlay titles/ })).toHaveTextContent('Off');
  });

  // Without this the change sat behind a five-minute staleTime and only a
  // manual reload showed it.
  it('marks every clip preview stale', async () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: false, text: '' });
    // Seeded as a card that has already fetched, which is what goes stale.
    client.setQueryData(['clipCaptions', 'test-project', 0], { cues: [] });
    open();
    drag(/^Position/, '40');

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(client.getQueryState(['clipCaptions', 'test-project', 0])?.isInvalidated).toBe(true);
    });
  });

  // Closing is a way out like any other, and the last change is still sitting
  // in the debounce when it happens.
  it('sends what the debounce is holding when the dialog is closed', async () => {
    renderStyler({ ...DEFAULT_OVERLAY_TEXT, enabled: false, text: '' });
    open();
    drag(/^Position/, '40');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateProjectSettings).mock.calls[0][1]).toMatchObject({
      overlay: expect.objectContaining({ position_pct: 40 }),
    });
  });
});
