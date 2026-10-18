import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../api';

/**
 * Cover for the stored secrets alone: opening the page must never write over
 * them, which it did while the debounced copy of a box still held the empty
 * value it started at.
 */

const stored = {
  settings: {
    gemini_api_key: 'STORED-KEY',
    youtube_client_secrets: { installed: { client_id: 'a', client_secret: 'b' } },
    theme: 'light' as const,
    video_defaults: { resolution: 'keep original', aspect_ratio: 'keep original' },
  },
  pipeline_config: { execution_order: [], steps: {} },
};

// The keys live on the Secrets tab.
const renderPage = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage theme="light" setTheme={() => {}} />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Secrets' }));
};

// Longer than the 500ms debounce, so a save that was going to happen has.
const pastDebounce = () => new Promise((resolve) => setTimeout(resolve, 900));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getSettings').mockResolvedValue(stored as never);
  vi.spyOn(api, 'getResolutionMap').mockResolvedValue({});
  vi.spyOn(api, 'getAspectRatioMap').mockResolvedValue({});
  vi.spyOn(api, 'getCaptionStyles').mockResolvedValue({} as never);
  vi.spyOn(api, 'getDescriptionFields').mockResolvedValue({} as never);
  vi.spyOn(api, 'getYoutubeStatus').mockResolvedValue({
    connected: false,
    has_client_secrets: true,
  });
});

describe('SettingsPage secrets', () => {
  it('leaves the stored keys alone when the page is only opened', async () => {
    const save = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never);

    await renderPage();
    expect(await screen.findByLabelText(/Gemini API Key/i)).toHaveValue('STORED-KEY');
    await pastDebounce();

    expect(save).not.toHaveBeenCalled();
  });

  it('saves a key the user types', async () => {
    const save = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never);

    await renderPage();
    const input = await screen.findByLabelText(/Gemini API Key/i);
    fireEvent.change(input, { target: { value: 'NEW-KEY' } });

    // react-query hands the mutation function a context object as well, so
    // only the payload is worth asserting on.
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({ settings: { gemini_api_key: 'NEW-KEY' } });
  });

  it('saves the empty box when the user clears the key themselves', async () => {
    const save = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never);

    await renderPage();
    const input = await screen.findByLabelText(/Gemini API Key/i);
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({ settings: { gemini_api_key: '' } });
  });

  it('saves a Jev key the user types', async () => {
    const save = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never);

    await renderPage();
    const input = await screen.findByLabelText(/Jev \(TypeSafe\) API Key/i);
    fireEvent.change(input, { target: { value: 'TS-KEY' } });

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({ settings: { typesafe_api_key: 'TS-KEY' } });
  });
});
