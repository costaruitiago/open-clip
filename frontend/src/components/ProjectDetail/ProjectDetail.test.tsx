import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProjectDetail } from './ProjectDetail';
import type { ProjectMetadata } from '../../api';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    getResolutionMap: vi.fn(async () => ({ '1080p': '1920x1080', '720p': '1280x720' })),
    getAspectRatioMap: vi.fn(async () => ({ '16:9': '16:9', '9:16': '9:16' })),
    getExecutionStatus: vi.fn(async () => ({})),
    updateProjectSettings: vi.fn(async () => ({ status: 'ok' })),
    downloadMarkerEdl: vi.fn(async () => undefined),
    getCaptionStyles: vi.fn(async () => ({
      karaoke_pop: { label: 'Karaoke Pop', description: 'words pop', font_size_pct: 7, position_pct: 78 },
      clean_lines: { label: 'Clean Lines', description: 'plain blocks', font_size_pct: 4.8, position_pct: 86 },
    })),
    getClipCaptions: vi.fn(async () => ({ enabled: false, style: {}, duration: 0, cues: [] })),
    getActiveProcesses: vi.fn(async () => []),
  };
});

const highlight = (text: string, clip?: string) => ({
  highlight_text: text,
  viral_hook_text: `${text} hook`,
  video_description_for_x: 'x',
  video_description_for_reddit: 'reddit',
  video_description_for_linkedin: 'linkedin',
  start: 0,
  end: 1,
  is_clip_generated: Boolean(clip),
  generated_clip_filename: clip,
});

const metadata = (highlights: unknown[]): ProjectMetadata => ({
  project_id: 'p1',
  name: 'Test Project',
  created_at: new Date().toISOString(),
  // No `clips` field: cut clips are the highlights carrying
  // `is_clip_generated`, which is what ProjectMetadata declares.
  highlights: highlights as any[],
  settings: { resolution: '1080p', aspect_ratio: '16:9' },
  files: { original_file: 'original.mp4' },
});

const renderDetail = (props: Partial<React.ComponentProps<typeof ProjectDetail>> = {}) => {
  const onExecuteAction = props.onExecuteAction ?? vi.fn();
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ProjectDetail
          metadata={metadata([highlight('one'), highlight('two'), highlight('three')])}
          pipelineConfig={{ execution_order: ['clipper'], steps: {} }}
          activeProcesses={[]}
          onExecuteAction={onExecuteAction}
          onDeleteClip={vi.fn()}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, onExecuteAction };
};

describe('ProjectDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  // The header's "Render All Clips" button is gone: the Clips step already
  // started the same job, and its locked state — driven by depends_on —
  // enforces "no highlights, no render" without a second control.
  it('leaves rendering to the pipeline row', () => {
    renderDetail();

    expect(screen.queryByRole('button', { name: /Render All Clips/i })).toBeNull();
  });

  // Both working areas of the page were unnamed <section>s: not a landmark,
  // and no heading, so both of a screen reader's navigation lists were empty
  // between the project title and the end of the page.
  it('gives the clip grid a name to navigate by', () => {
    renderDetail();

    expect(screen.getByRole('heading', { name: /^Clips$/i })).toBeDefined();
    expect(screen.getByRole('region', { name: /^Clips$/i })).toBeDefined();
  });

  // The pipeline is in the header on a project that has run. It is still the
  // page on one that has not, and still named there.
  it('still names the pipeline while it is the whole page', () => {
    renderDetail({ metadata: metadata([]) });

    expect(screen.getByRole('heading', { name: /^Pipeline$/i })).toBeDefined();
    expect(screen.getByRole('region', { name: /^Pipeline$/i })).toBeDefined();
  });

  // Two shapes, one page.
  // ------------------------------------------------------------------------
  // A project with nothing in it is not the same page as a project with forty
  // clips in it. With no highlights there is nothing to review, so the
  // pipeline is the page; once there are clips it is a tool, and the grid has
  // the better claim on the fold.
  describe('shape', () => {
    it('leads with the pipeline when there is nothing to review yet', () => {
      renderDetail({ metadata: metadata([]) });

      const runAll = screen.getByRole('button', { name: /Run full pipeline/i });
      // Filled: on an empty project this is the only thing to do here.
      expect(runAll.style.backgroundColor).toBe('var(--text)');
      expect(runAll.style.fontSize).toBe('1rem');
    });

    it('no longer plays the source video beside the clips cut out of it', () => {
      renderDetail();

      // The aside and its player are gone, along with the two-column split.
      expect(screen.queryByLabelText(/Source video/i)).toBeNull();
      expect(document.querySelector('.project-layout__aside')).toBeNull();
      // The grid still previews from the source — every player left on the
      // page belongs to a clip card.
      const players = Array.from(document.querySelectorAll('video'));
      expect(players.length).toBeGreaterThan(0);
      players.forEach((player) => expect(player.closest('.clip-card')).not.toBeNull());
    });

  });

  // The breadcrumb above this component already renders the project name, in
  // accent, carrying aria-current. The h1 under it drew the same filename
  // again, larger — two headings' worth of page to say one thing once.
  it('names the project for the document without painting it twice', () => {
    renderDetail();

    // Still a heading: the document needs one, and it is how a screen reader
    // finds the page.
    const heading = screen.getByRole('heading', { name: /Test Project/i, level: 1 });
    expect(heading.className).toContain('visually-hidden');
  });

  // A card per highlight, cut or not, and neither labelled by its pipeline
  // state: "Rendered" and "Preview" both said nothing about the clip itself.
  it('shows a card for every highlight, cut or not', () => {
    renderDetail({
      metadata: metadata([highlight('rendered one', 'clip_000.mp4'), highlight('still a preview')]),
    });

    expect(document.querySelectorAll('.clip-card')).toHaveLength(2);
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.queryByText('Rendered')).toBeNull();
  });

});
