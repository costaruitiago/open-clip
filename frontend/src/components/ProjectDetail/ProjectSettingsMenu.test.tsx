import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectSettingsMenu } from './ProjectSettingsMenu';
import type { ProjectMetadata } from '../../api';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getResolutionMap: vi.fn(async () => ({ '1080p': '1920x1080', '720p': '1280x720' })),
    getAspectRatioMap: vi.fn(async () => ({ '16:9': '16:9', '9:16': '9:16' })),
    updateProjectSettings: vi.fn(async () => ({ status: 'ok' })),
    getCaptionStyles: vi.fn(async () => ({
      karaoke_pop: { label: 'Karaoke Pop', description: 'words pop', font_size_pct: 7, position_pct: 78 },
      clean_lines: { label: 'Clean Lines', description: 'plain blocks', font_size_pct: 4.8, position_pct: 86 },
    })),
    getClipCaptions: vi.fn(async () => ({ enabled: false, style: {}, duration: 0, cues: [] })),
  };
});

const metadata = (overrides: Partial<ProjectMetadata> = {}): ProjectMetadata => ({
  project_id: 'p1',
  name: 'Test Project',
  created_at: new Date().toISOString(),
  highlights: [],
  settings: { resolution: '1080p', aspect_ratio: '16:9' },
  files: { original_file: 'original.mp4' },
  ...overrides,
});

const renderMenu = (data: ProjectMetadata = metadata()) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectSettingsMenu metadata={data} />
    </QueryClientProvider>
  );

// These settings apply to every clip at once, so they belong with the other
// project-level actions in the header rather than in a row across the page.
// The tests came here with them.
describe('ProjectSettingsMenu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names every settings control for assistive tech', () => {
    renderMenu();

    expect(screen.getByLabelText(/Resolution/i)).toBeDefined();
    expect(screen.getByLabelText(/Aspect Ratio/i)).toBeDefined();
  });

  // Disabling the select the user is standing in hands focus to the document
  // body, so a keyboard user is returned to the top of the page for having
  // changed a setting — and it deadened the other two along with it.
  it('leaves the settings usable while one of them is saving', async () => {
    const { updateProjectSettings } = await import('../../api');
    vi.mocked(updateProjectSettings).mockImplementationOnce(() => new Promise(() => {}));
    renderMenu();

    await screen.findByRole('option', { name: '720p' });
    const resolution = screen.getByLabelText(/Resolution/i) as HTMLSelectElement;
    fireEvent.change(resolution, { target: { value: '720p' } });

    expect(resolution.disabled).toBe(false);
    expect((screen.getByLabelText(/Aspect Ratio/i) as HTMLSelectElement).disabled).toBe(false);
  });

  // The value comes from the project, which has not been refetched yet — so
  // without holding the pick locally the select snapped back to the old option
  // and read as a refusal rather than a save.
  it('keeps showing the value you picked while it is being saved', async () => {
    const { updateProjectSettings } = await import('../../api');
    vi.mocked(updateProjectSettings).mockImplementationOnce(() => new Promise(() => {}));
    renderMenu();

    await screen.findByRole('option', { name: '720p' });
    const resolution = screen.getByLabelText(/Resolution/i) as HTMLSelectElement;
    fireEvent.change(resolution, { target: { value: '720p' } });

    await waitFor(() => expect(resolution.value).toBe('720p'));
  });

  // One mutation serves all three controls, so "could not save that setting"
  // left the user to work out which of the three it meant.
  it('names the setting that failed to save, and puts the value back', async () => {
    const { updateProjectSettings } = await import('../../api');
    vi.mocked(updateProjectSettings).mockRejectedValueOnce(new Error('Disk full'));
    renderMenu();

    await screen.findByRole('option', { name: '9:16' });
    const aspect = screen.getByLabelText(/Aspect Ratio/i) as HTMLSelectElement;
    fireEvent.change(aspect, { target: { value: '9:16' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not save the aspect ratio/i);
    expect(alert.textContent).toMatch(/Disk full/i);
    // The server stored nothing, so the control must stop claiming otherwise.
    await waitFor(() => expect(aspect.value).toBe('16:9'));
    expect(aspect.getAttribute('aria-describedby')).toBe(alert.id);
  });

  // A select whose stored value is missing from a not-yet-loaded option map
  // displays the first option instead, which told the user the project was on
  // "keep original" when it was not.
  it('offers the stored value even before the option map arrives', () => {
    renderMenu(metadata({ settings: { resolution: '4k', aspect_ratio: '16:9' } }));

    expect((screen.getByLabelText(/Resolution/i) as HTMLSelectElement).value).toBe('4k');
  });

  // The darkness only means anything for the stacked layout, so a cropping
  // project is not shown a slider that does nothing.
  it('offers the band darkness only once the layout is stacked', async () => {
    const { updateProjectSettings } = await import('../../api');
    renderMenu();

    const layout = screen.getByLabelText(/Layout/i) as HTMLSelectElement;
    expect(layout.value).toBe('crop');
    expect(screen.queryByLabelText(/Band darkness/i)).toBeNull();

    fireEvent.change(layout, { target: { value: 'stacked' } });

    await waitFor(() =>
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { layout: 'stacked' })
    );
    const darkness = (await screen.findByLabelText(/Band darkness/i)) as HTMLInputElement;
    expect(darkness.value).toBe('50');

    fireEvent.change(darkness, { target: { value: '70' } });
    await waitFor(() =>
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { stack_darkness: 70 })
    );
  });

  it('offers the split controls only once the layout is split', async () => {
    const { updateProjectSettings } = await import('../../api');
    renderMenu();
    expect(screen.queryByLabelText(/Split at/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Layout/i), { target: { value: 'split' } });
    await waitFor(() =>
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { layout: 'split' })
    );
    expect(screen.queryByLabelText(/Band darkness/i)).toBeNull();

    fireEvent.change(await screen.findByLabelText(/Split at/i), { target: { value: '40' } });
    fireEvent.click(screen.getByLabelText(/Right part on top/i));
    fireEvent.click(screen.getByLabelText(/Divider line/i));
    await waitFor(() => {
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { split_position: 40 });
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { split_swap: true });
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', { split_divider: true });
    });
  });

  it('keeps a darkness of zero rather than reading it as unset', () => {
    renderMenu(metadata({ settings: { resolution: '1080p', aspect_ratio: '9:16', layout: 'stacked', stack_darkness: 0 } }));

    expect((screen.getByLabelText(/Band darkness/i) as HTMLInputElement).value).toBe('0');
  });

  // Captions have to be settable before the clipper runs, otherwise the only
  // way to reach them is a clip already rendered without them. The form is set
  // once and rarely revisited, so the menu carries a button and the dialog
  // carries the controls.
  it('keeps the caption form in a dialog rather than in the menu', async () => {
    renderMenu();

    expect(await screen.findByRole('button', { name: /Captions/i })).toBeDefined();
    expect(screen.queryByLabelText(/Burn captions into rendered clips/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Captions/i }));

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByLabelText(/Burn captions into rendered clips/i)).toBeDefined();
  });

  it('saves a caption preset change against the project', async () => {
    const { updateProjectSettings } = await import('../../api');
    renderMenu();

    fireEvent.click(await screen.findByRole('button', { name: /Captions/i }));
    await screen.findByRole('option', { name: 'Clean Lines' });
    fireEvent.change(screen.getByLabelText(/^Preset$/i), { target: { value: 'clean_lines' } });

    await waitFor(() =>
      expect(vi.mocked(updateProjectSettings)).toHaveBeenCalledWith('p1', {
        captions: { enabled: false, preset: 'clean_lines', overrides: {} },
      })
    );
  });

  // Closed, the button must still admit what it is hiding — otherwise a
  // customised project looks identical to an untouched one.
  it('summarises the caption settings without being opened', async () => {
    renderMenu(
      metadata({
        settings: {
          resolution: '1080p',
          aspect_ratio: '16:9',
          captions: { enabled: true, preset: 'karaoke_pop', overrides: { font_size_pct: 9, uppercase: true } },
        },
      })
    );

    const trigger = await screen.findByRole('button', { name: /Captions/i });
    expect(trigger.textContent).toMatch(/On/);
    expect(trigger.textContent).toMatch(/2 adjusted/i);
  });
});
