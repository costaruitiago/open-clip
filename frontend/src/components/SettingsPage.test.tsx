import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../api';

/**
 * Cover for the YouTube channel panel alone: whether a connection is short of
 * a permission, and what the button does about it.
 */

const settings = {
  settings: {
    gemini_api_key: '',
    youtube_client_secrets: { installed: { client_id: 'a', client_secret: 'b' } },
    theme: 'light' as const,
    video_defaults: { resolution: 'keep original', aspect_ratio: 'keep original' },
  },
  pipeline_config: { execution_order: [], steps: {} },
};

// Everything covered here lives on the YouTube tab.
const renderPage = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage theme="light" setTheme={() => {}} />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'YouTube' }));
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings as never);
  vi.spyOn(api, 'getResolutionMap').mockResolvedValue({});
  vi.spyOn(api, 'getAspectRatioMap').mockResolvedValue({});
  vi.spyOn(api, 'getCaptionStyles').mockResolvedValue({} as never);
  vi.spyOn(api, 'getDescriptionFields').mockResolvedValue({} as never);
});

describe('SettingsPage YouTube channel', () => {
  it('says a token short of the read scope is connected, and why that matters', async () => {
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: true,
      account: 'someone@example.com',
      missing_scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      has_client_secrets: true,
    });

    await renderPage();

    expect(await screen.findByText(/Connected as someone@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Missing permission/)).toBeInTheDocument();
    // Uploads are unaffected, so the button is an offer rather than a demand.
    expect(screen.getByRole('button', { name: /Reconnect Channel/i })).toBeEnabled();
  });

  it('shows a refused authorisation as the error it is', async () => {
    // The state that looked like nothing was wrong: the file is still there,
    // the page said "Connected", and every upload failed.
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: false,
      expired: true,
      reason:
        'YouTube has rejected the stored authorisation for this channel: invalid_grant: ' +
        'Token has been expired or revoked. Open Settings and connect the channel again.',
      has_client_secrets: true,
    });

    await renderPage();

    const reason = await screen.findByText(/YouTube has rejected the stored authorisation/);
    expect(reason).toHaveStyle({ color: 'var(--error)' });
    expect(screen.getByRole('button', { name: /Connect Channel/i })).toBeEnabled();
  });

  it('opens the consent Google returns in a tab of its own', async () => {
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: false,
      reason: 'No YouTube account has been connected yet.',
      has_client_secrets: true,
    });
    const connect = vi
      .spyOn(api, 'connectYoutube')
      .mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=1' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Connect Channel/i }));

    await waitFor(() => expect(connect).toHaveBeenCalled());
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/auth?x=1',
        '_blank',
        'noopener'
      )
    );
  });

  it('opens another sign-in while one is still waiting', async () => {
    // Closing the tab leaves the backend waiting for a redirect that is never
    // coming. That is the moment this button matters most, so it stays live
    // and simply opens another window.
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: false,
      has_client_secrets: true,
      consent: { pending: true, completed: false, cancelled: false, error: null },
    });
    const connect = vi
      .spyOn(api, 'connectYoutube')
      .mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=2' });
    vi.spyOn(window, 'open').mockReturnValue(null);

    await renderPage();
    const again = await screen.findByRole('button', { name: /Open Sign-in Again/i });
    expect(again).toBeEnabled();
    fireEvent.click(again);

    await waitFor(() => expect(connect).toHaveBeenCalled());
  });

  it('can abandon a consent left waiting', async () => {
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: false,
      has_client_secrets: true,
      consent: { pending: true, completed: false, cancelled: false, error: null },
    });
    const cancel = vi.spyOn(api, 'cancelYoutubeConnect').mockResolvedValue({ status: 'success' });

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it('cannot start a consent before the client secrets are in', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      ...settings,
      settings: { ...settings.settings, youtube_client_secrets: null },
    } as never);
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: false,
      reason: 'No YouTube account has been connected yet.',
      has_client_secrets: false,
    });

    await renderPage();

    expect(await screen.findByRole('button', { name: /Connect Channel/i })).toBeDisabled();
    expect(screen.getByText(/Add the YouTube client secrets under/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secrets' })).toBeInTheDocument();
  });
});

/**
 * Waits for one setting to have been saved.
 *
 * The payload alone: react-query hands the mutation function a context object
 * as a second argument, so asserting on the whole call never matches.
 */
const saved = (
  update: ReturnType<typeof vi.spyOn<typeof api, 'updateSettings'>>,
  settings: Record<string, unknown>
) =>
  waitFor(() =>
    expect(update.mock.calls.map((call) => call[0])).toContainEqual({ settings })
  );

describe('SettingsPage upload privacy', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
      connected: true,
      has_client_secrets: true,
      privacy: 'private',
    });
  });

  it('starts on private, which is the one that reaches nobody by accident', async () => {
    await renderPage();

    expect(await screen.findByLabelText(/Privacy/)).toHaveValue('private');
  });

  it('asks for a calendar only once the uploads are scheduled', async () => {
    // Installed before the page is rendered: react-query holds the mutation
    // function it was given, so a spy set up afterwards is never called.
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({ status: 'success' } as never);

    await renderPage();
    await screen.findByLabelText(/Privacy/);

    expect(screen.queryByLabelText(/Start date/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Privacy/), {
      target: { value: 'schedule' },
    });

    await saved(update, { youtube_privacy: 'schedule' });
  });

  it('saves the day a scheduled run begins and how it is spread', async () => {
    vi.spyOn(api, 'getSettings').mockResolvedValue({
      ...settings,
      settings: { ...settings.settings, youtube_privacy: 'schedule' },
    } as never);
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({ status: 'success' } as never);

    await renderPage();

    fireEvent.change(await screen.findByLabelText(/Start date/), {
      target: { value: '2026-09-01' },
    });
    await saved(update, { youtube_schedule_start_date: '2026-09-01' });

    fireEvent.change(screen.getByLabelText(/Per day/), { target: { value: '2' } });
    await saved(update, { youtube_schedule_per_day: 2 });

    // Nine to nine unless somebody says otherwise, and picked on this
    // machine's clock — which is the one thing the numbers cannot say. Scoped
    // to the YouTube window: the page carries a second one for Postiz, and
    // "From" says nothing about which schedule it belongs to.
    const window = within(screen.getByRole('group', { name: /YouTube clips go public/ }));
    expect(window.getByLabelText(/From/)).toHaveValue('9');
    expect(window.getByLabelText(/^to$/)).toHaveValue('21');
    fireEvent.change(window.getByLabelText(/From/), { target: { value: '8' } });
    await saved(update, { youtube_schedule_day_start_hour: 8 });
  });
});
