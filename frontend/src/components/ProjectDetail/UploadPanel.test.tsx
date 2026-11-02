import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UploadPanel } from './UploadPanel';
import { getYoutubeStatus, updateProjectSettings, type UploadProjectSettings } from '../../api';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    updateProjectSettings: vi.fn(async () => ({ status: 'ok' })),
    getYoutubeStatus: vi.fn(async () => ({
      connected: true,
      channels: [
        { id: 'UC-one', title: 'Main Channel', connected: true },
        { id: 'UC-two', title: 'Side Channel', connected: true },
      ],
      default_channel: 'UC-one',
      has_client_secrets: true,
      // What Settings says, which is what a project follows until it disagrees.
      privacy: 'unlisted' as const,
    })),
  };
});

/** A project that has no opinion about anything, which is every new project. */
const FOLLOWING: UploadProjectSettings = {
  channel_id: null,
  privacy: null,
  per_day: null,
  start_date: null,
  day_start_hour: null,
  day_end_hour: null,
};

const open = async (settings?: Partial<UploadProjectSettings>) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UploadPanel projectId="p1" settings={settings && { ...FOLLOWING, ...settings }} />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: /YouTube/ }));
  await waitFor(() => expect(getYoutubeStatus).toHaveBeenCalled());
  await screen.findByLabelText(/Visibility/);
};

describe('UploadPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  // The default has to be named rather than called "the default": a user who
  // has to go and look it up cannot tell what this project would publish.
  it('names the application default a project is following', async () => {
    await open();

    expect(screen.getByText('Default')).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Default: Unlisted/ })).toBeDefined()
    );
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it('gives the project its own privacy when one is picked', async () => {
    await open();

    fireEvent.change(screen.getByLabelText(/Visibility/), { target: { value: 'public' } });

    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { privacy: 'public' } })
    );
  });

  it('lets a project that chose its own privacy follow the default again', async () => {
    await open({ privacy: 'public' });

    expect(screen.getByText('Public')).toBeDefined();
    fireEvent.change(screen.getByLabelText(/Visibility/), { target: { value: '' } });

    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { privacy: null } })
    );
  });

  // The badge is the only thing on the page saying whether this project has
  // decided anything, so a project with its own calendar cannot read "Default".
  it('counts every setting the project chose, not just the privacy', async () => {
    await open({ per_day: 2, day_start_hour: 9 });

    expect(screen.getByText('2 chosen')).toBeDefined();
    expect(screen.queryByText('Default')).toBeNull();
  });

  it('counts a lone setting that is not the privacy', async () => {
    await open({ start_date: '2026-09-01' });

    expect(screen.getByText('1 chosen')).toBeDefined();
  });

  // The dates say nothing about a clip that is public the moment it lands, and
  // a form full of controls that change nothing is a form nobody can read.
  it('asks for a calendar only when the clips are scheduled', async () => {
    await open({ privacy: 'private' });

    expect(screen.queryByLabelText(/Start date/)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Visibility/), { target: { value: 'schedule' } });
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalled());
  });

  it('shows the calendar to a project whose own privacy is a schedule', async () => {
    await open({ privacy: 'schedule', start_date: '2026-09-01' });

    expect(screen.getByLabelText(/Start date/)).toHaveValue('2026-09-01');

    fireEvent.change(screen.getByLabelText(/Start date/), {
      target: { value: '2026-09-08' },
    });

    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { start_date: '2026-09-08' } })
    );
  });

  // Following a scheduled default is being on a schedule: the fields have to
  // be reachable without first restating the privacy this project agrees with.
  it('shows the calendar to a project following a scheduled default', async () => {
    vi.mocked(getYoutubeStatus).mockResolvedValueOnce({
      connected: true,
      channels: [],
      default_channel: null,
      has_client_secrets: true,
      privacy: 'schedule',
    });

    await open();

    await screen.findByLabelText(/Start date/);
  });

  it('sends an emptied date as following Settings rather than as a blank day', async () => {
    await open({ privacy: 'schedule', start_date: '2026-09-01' });
    const date = screen.getByLabelText(/Start date/);

    // Cleared, then left: a date input reads empty half-typed too, so the
    // empty is only an answer once the user is out of the field.
    fireEvent.change(date, { target: { value: '' } });
    expect(updateProjectSettings).not.toHaveBeenCalled();

    fireEvent.blur(date, { target: { value: '' } });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { start_date: null } })
    );
  });

  // 0 is "all at the same moment" and an empty select is "follow Settings".
  // Sending 0 for both publishes a project the user never scheduled.
  it('tells all-at-once apart from having no opinion', async () => {
    await open({ privacy: 'schedule' });

    fireEvent.change(screen.getByLabelText(/Clips per day/), { target: { value: '0' } });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { per_day: 0 } })
    );

    fireEvent.change(screen.getByLabelText(/Clips per day/), { target: { value: '' } });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { per_day: null } })
    );
  });

  it('saves the hours the day is spread between', async () => {
    await open({ privacy: 'schedule' });

    fireEvent.change(screen.getByLabelText(/From/), { target: { value: '8' } });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { day_start_hour: 8 } })
    );

    fireEvent.change(screen.getByLabelText(/^to$/), { target: { value: '18' } });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { day_end_hour: 18 } })
    );
  });

  it('names the default channel and saves a channel of its own', async () => {
    await open();
    const channel = screen.getByLabelText('Channel');

    expect(await screen.findByRole('option', { name: /Default: Main Channel/ })).toBeInTheDocument();
    fireEvent.change(channel, { target: { value: 'UC-two' } });

    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { upload: { channel_id: 'UC-two' } })
    );
  });

  it('warns when the channel it picked is no longer connected', async () => {
    await open({ channel_id: 'UC-gone' });

    expect(await screen.findByText(/no longer connected. Uploads will fail/)).toBeInTheDocument();
  });
});
