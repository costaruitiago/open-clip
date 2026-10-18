import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClipDetail } from './ClipDetail';
import { stubFrameSize } from '../../test/stubFrame';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getProjectMetadata,
  getClipCaptions,
  regenerateClip,
  syncPostiz,
  updateClipOverlay,
  uploadClip,
  type CaptionStyle,
  type Highlight,
  type OverlayText,
  type ProjectMetadata,
} from '../../api';

// Typed rather than cast at each use. `animation` widens to `string` in a bare
// object literal, which is what every `as any` in this file used to paper over.
const captionStyle: CaptionStyle = {
  label: 'Karaoke Pop',
  description: 'preset description',
  animation: 'karaoke',
  words_per_cue: 4,
  font_family: 'Arial Black',
  font_size_pct: 7,
  bold: true,
  italic: false,
  uppercase: false,
  text_color: '#FFFFFF',
  active_color: '#FFE500',
  outline_color: '#000000',
  shadow_color: '#000000',
  box_color: null,
  outline_pct: 0.7,
  shadow_pct: 0.5,
  position_pct: 78,
  max_width_pct: 86,
  active_scale: 1.14,
};

// The preview payload also carries the resolved face, and whether this clip
// follows the project's caption settings or keeps its own.
const captionFont = { family: 'Arial Black', height_ratio: 1.2, url: null };

// A title as the backend stores it, for the tests that give a clip one.
const overlayText: OverlayText = {
  enabled: true,
  text: '',
  start: 0,
  duration: 3,
  fade_in: 0.3,
  fade_out: 0.6,
  font_family: 'Arial Black',
  font_size_pct: 8,
  bold: true,
  italic: false,
  uppercase: false,
  text_color: '#FFFFFF',
  outline_color: '#000000',
  outline_pct: 0.6,
  shadow_color: '#000000',
  shadow_pct: 0.8,
  highlight_color: '#FFE000',
  box_color: null,
  position_pct: 12,
  max_width_pct: 86,
};

vi.mock('../../api', () => ({
  getProjectMetadata: vi.fn(),
  getClipVideoUrl: (projectId: string, filename: string, version?: string | null) =>
    `/static/${projectId}/clips/${filename}${version ? `?v=${version}` : ''}`,
  getSourceVideoUrl: (projectId: string, file: string) => `/static/${projectId}/${file}`,
  getAspectRatioMap: vi.fn().mockResolvedValue({ '9:16': '9:16' }),
  getResolutionMap: vi.fn().mockResolvedValue({ '1080p': '1920x1080' }),
  getCaptionStyles: vi.fn().mockResolvedValue({}),
  getClipCaptions: vi.fn(),
  // Every published clip asks whether its video is still on YouTube. "Still
  // there" is the default; the tests that care say otherwise.
  getClipPublication: vi.fn().mockResolvedValue({
    published: true,
    video_id: 'abc123',
    url: 'https://youtube.com/watch?v=abc123',
    checked: true,
  }),
  // A clip in Postiz asks what has become of it whenever this page opens: the
  // clip route is not a child of the project one, so landing here directly is
  // the case where nothing else would ask.
  syncPostiz: vi.fn().mockResolvedValue({ checked: true, clips: {} }),
  updateProjectSettings: vi.fn().mockResolvedValue({ status: 'success' }),
  updateClipOverlay: vi.fn().mockResolvedValue({ status: 'success', overlay: null }),
  uploadClip: vi.fn(),
  regenerateClip: vi.fn(),
  getActiveProcesses: vi.fn().mockResolvedValue([]),
  // Inline rather than the `overlayText` below: a mock factory is hoisted above
  // everything in this file, so it can only close over what it defines itself.
  DEFAULT_OVERLAY_TEXT: {
    enabled: true,
    text: '',
    start: 0,
    duration: 3,
    fade_in: 0.3,
    fade_out: 0.6,
    font_family: 'Arial Black',
    font_size_pct: 8,
    bold: true,
    italic: false,
    uppercase: true,
    text_color: '#FFFFFF',
    outline_color: '#000000',
    outline_pct: 0.6,
    box_color: null,
    position_pct: 12,
    max_width_pct: 86,
  },
  getStudioEditUrl: (videoId: string) => `https://studio.youtube.com/video/${videoId}/edit`,
}));

const highlight = (overrides: Partial<Highlight> = {}): Highlight => ({
  highlight_text: 'transcript',
  viral_hook_text: 'hook',
  video_title_for_youtube_short: 'yt title',
  video_description_for_x: 'x post',
  video_description_for_reddit: 'reddit post',
  video_description_for_linkedin: 'linkedin post',
  start: 0,
  end: 10,
  is_clip_generated: false,
  generated_clip_filename: null,
  ...overrides,
});

const project = (highlights: Highlight[]): ProjectMetadata => ({
  project_id: 'test-project',
  name: 'test',
  created_at: '2026-01-01T00:00:00',
  files: { original_file: 'original.mp4' },
  settings: { aspect_ratio: '9:16', resolution: 'keep original' },
  highlights,
});

const renderDetail = (clipIndex: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/project/test-project/clip/${clipIndex}`]}>
        <Routes>
          <Route path="/project/:id/clip/:clipIndex" element={<ClipDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

describe('ClipDetail Component', () => {
  // The caption overlay sizes itself from the preview frame, which jsdom
  // measures as zero unless one is stood in.
  beforeAll(() => stubFrameSize(400));

  /**
   * The caption preview, carrying the title this clip resolves to.
   *
   * The page reads the title from here rather than off the highlight, because
   * a clip that has never taken one of its own draws the project's and only
   * the backend knows which of the two that is. `null` is a backend older than
   * the project-level setting.
   */
  const captionsWith = (overlay: OverlayText | null, locked = true) => ({
    enabled: true,
    style: captionStyle,
    font: captionFont,
    locked: true,
    settings: null,
    overlay,
    overlay_font: overlay ? captionFont : null,
    overlay_locked: locked,
    duration: 10,
    cues: [],
  });

  beforeEach(() => {
    vi.mocked(getProjectMetadata).mockReset();
    vi.mocked(getClipCaptions).mockReset();
    // Left unreset, a publish from one test counts as a publish in the next,
    // and the tests asserting that nothing was uploaded pass or fail on
    // ordering rather than on behaviour.
    vi.mocked(uploadClip).mockReset();
    // Same reasoning: a sync from one test would otherwise count as a sync in
    // the next, and "this project asks nothing of Postiz" would pass or fail on
    // ordering.
    vi.mocked(syncPostiz).mockReset();
    vi.mocked(syncPostiz).mockResolvedValue({ checked: true, clips: {} });
    vi.mocked(getClipCaptions).mockResolvedValue(captionsWith(null));
  });

  // Nothing tells this application when a draft in Postiz is sent, so until the
  // sync existed a clip that went out an hour ago said "waiting in Postiz"
  // forever — next to a button that would have filed a duplicate.
  describe('what Postiz has done with the post', () => {
    const inPostiz = (overrides: Partial<Highlight> = {}) =>
      highlight({
        postiz_post_id: 'post-1',
        postiz_url: 'https://postiz.example.com',
        postiz_imported_at: '2026-08-22T08:37:12',
        ...overrides,
      });

    // This route is a sibling of the project page, not a child of it, so
    // opening a clip's URL directly — a bookmark, a reload, a link — is the one
    // case where nothing else would ask. Without this the page drew whatever
    // was last written: a clip published an hour ago still said "waiting".
    it('asks Postiz what happened as soon as the page opens', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([inPostiz()]));

      renderDetail('0');

      await waitFor(() => expect(syncPostiz).toHaveBeenCalledWith('test-project'));
      // And the project is re-read, because the sync just rewrote it.
      await waitFor(() => expect(getProjectMetadata).toHaveBeenCalledTimes(2));
    });

    it('asks nothing of Postiz for a project with nothing filed there', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight()]));

      renderDetail('0');

      await screen.findByText(/hook/i);
      expect(syncPostiz).not.toHaveBeenCalled();
    });

    it('says a clip is still waiting when Postiz has not sent it', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([inPostiz()]));

      renderDetail('0');

      expect(await screen.findByText(/Waiting in Postiz/)).toBeDefined();
    });

    it('says a clip is published, and links to the post on the platform', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          inPostiz({
            postiz_state: 'published',
            postiz_channels: [
              {
                id: 'chan-li',
                name: 'Coffee and Bytes',
                platform: 'linkedin',
                state: 'published',
                url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:749',
              },
            ],
          }),
        ])
      );

      renderDetail('0');

      expect(await screen.findByText(/Published from Postiz/)).toBeDefined();
      // The calendar is no longer where anyone wants to be sent.
      const live = screen.getByRole('link', { name: 'Coffee and Bytes' });
      expect(live).toHaveAttribute(
        'href',
        'https://www.linkedin.com/feed/update/urn:li:ugcPost:749'
      );
    });

    // A clip filed to two accounts and published on one showed a single name,
    // and nothing said the second account existed, let alone what it was doing.
    it('names every channel the clip went to, published or not', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          inPostiz({
            postiz_state: 'published',
            postiz_channels: [
              {
                id: 'chan-page',
                name: 'Coffee and Bytes',
                platform: 'linkedin-page',
                state: 'published',
                url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:749',
              },
              { id: 'chan-me', name: 'Rui Costa', platform: 'linkedin' },
            ],
          }),
        ])
      );

      renderDetail('0');

      // The one that is out links to the post; the one that is not is still
      // named, and says what it is doing.
      expect(await screen.findByRole('link', { name: 'Coffee and Bytes' })).toBeDefined();
      expect(screen.getByText(/Rui Costa/)).toBeDefined();
      expect(screen.getByText(/waiting/)).toBeDefined();
    });

    it('says when Postiz could not send it', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([inPostiz({ postiz_state: 'error' })])
      );

      renderDetail('0');

      expect(await screen.findByText(/could not send this/)).toBeDefined();
    });
  });

  it('shows a loading state while the project is being fetched', () => {
    vi.mocked(getProjectMetadata).mockReturnValue(new Promise(() => {}));
    renderDetail('0');
    expect(screen.getByText(/Loading/i)).toBeDefined();
  });

  // The grid renders one card per highlight, rendered or not, so the route
  // index counts positions in `highlights`.
  it('resolves the route index against every highlight', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({ viral_hook_text: 'FIRST CUT', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
        highlight({ viral_hook_text: 'NOT RENDERED', highlight_text: 'second transcript' }),
        highlight({ viral_hook_text: 'THIRD', is_clip_generated: true, generated_clip_filename: 'third.mp4' }),
      ])
    );

    renderDetail('1');

    const video = await screen.findByLabelText('NOT RENDERED');
    expect(video.getAttribute('src')).toBe('/static/test-project/original.mp4');
    expect(screen.getByText('second transcript')).toBeDefined();
    expect(screen.queryByText('FIRST CUT')).toBeNull();
  });

  it('plays a rendered clip from its own file and loops it', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({ viral_hook_text: 'FIRST CUT', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
      ])
    );

    renderDetail('0');

    const video = (await screen.findByLabelText('FIRST CUT')) as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/static/test-project/clips/first.mp4');
    // Review loop: playback repeats until the user pauses.
    expect(video.loop).toBe(true);
  });

  // Changing the project's ratio re-shapes this player and re-cuts nothing, so
  // the file made under the old ratio would play inside a frame it was never
  // cut for — a crop the clipper will not produce, shown as the finished clip.
  it('goes back to the source once the file no longer matches the output settings', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'FIRST CUT',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          rendered_aspect_ratio: '16:9',
          rendered_resolution: 'keep original',
        }),
      ])
    );

    renderDetail('0');

    const video = (await screen.findByLabelText('FIRST CUT')) as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/static/test-project/original.mp4');
  });

  // The related-video chip has no field in the Data API, so the upload cannot
  // attach it and the page has to hand over the one place that can.
  it('points a published clip at its Studio page, where the related video is set', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'PUBLISHED',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          youtube_video_id: 'abc123',
          youtube_url: 'https://youtube.com/watch?v=abc123',
        }),
      ])
    );

    renderDetail('0');

    const studio = (await screen.findByRole('link', { name: /Studio/i })) as HTMLAnchorElement;
    expect(studio.href).toBe('https://studio.youtube.com/video/abc123/edit');
  });

  // Nothing tells this application when a video it published is deleted, so
  // the record outlives the video. The server checks and clears it; the page
  // must not go on offering a dead link in the meantime.
  it('stops claiming a clip is published once its video has gone from YouTube', async () => {
    const { getClipPublication } = await import('../../api');
    vi.mocked(getClipPublication).mockResolvedValue({
      published: false,
      video_id: null,
      url: null,
      checked: true,
    });
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'PUBLISHED',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          youtube_video_id: 'abc123',
          youtube_url: 'https://youtube.com/watch?v=abc123',
        }),
      ])
    );

    renderDetail('0');

    await waitFor(() => expect(screen.queryByRole('link', { name: /Studio/i })).toBeNull());
    expect(screen.queryByText(/youtube\.com\/watch/)).toBeNull();
  });

  // No channel connected, no read scope, no network. Not being able to ask is
  // not a "no", and a good record must survive it.
  it('keeps the record when the check could not be made at all', async () => {
    const { getClipPublication } = await import('../../api');
    vi.mocked(getClipPublication).mockResolvedValue({
      published: true,
      video_id: 'abc123',
      url: 'https://youtube.com/watch?v=abc123',
      checked: false,
    });
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'PUBLISHED',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          youtube_video_id: 'abc123',
          youtube_url: 'https://youtube.com/watch?v=abc123',
        }),
      ])
    );

    renderDetail('0');

    expect(await screen.findByRole('link', { name: /Studio/i })).toBeDefined();
  });

  it('draws the captions the clipper would burn in over the preview', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([highlight({ viral_hook_text: 'NOT RENDERED' })])
    );
    vi.mocked(getClipCaptions).mockResolvedValue({
      ...captionsWith(null),
      cues: [{ start: 0, end: 1, text: 'first words', words: [
        { text: 'first', start: 0, end: 0.5 },
        { text: 'words', start: 0.5, end: 1 },
      ] }],
    });

    renderDetail('0');

    // The player starts at the top of the window, so the first cue is up.
    expect(await screen.findByText('first')).toBeDefined();
  });

  it('does not overlay captions on a clip whose file already has them burned in', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'FIRST CUT',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          captions_burned: true,
        }),
      ])
    );
    vi.mocked(getClipCaptions).mockResolvedValue({
      ...captionsWith(null),
      cues: [{ start: 0, end: 1, text: 'burned in', words: [{ text: 'burned', start: 0, end: 1 }] }],
    });

    renderDetail('0');

    // The captions are in the file's own pixels; drawing them again would
    // double every word.
    await screen.findByLabelText('FIRST CUT');
    expect(screen.queryByText('burned')).toBeNull();
  });

  it('overlays captions on a clip rendered before captions were turned on', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'FIRST CUT',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          captions_burned: false,
        }),
      ])
    );
    vi.mocked(getClipCaptions).mockResolvedValue({
      ...captionsWith(null),
      cues: [{ start: 0, end: 1, text: 'not yet', words: [{ text: 'pending', start: 0, end: 1 }] }],
    });

    renderDetail('0');

    // Otherwise a project that has already been through the clipper shows no
    // captions anywhere, and the styling controls look broken.
    expect(await screen.findByText('pending')).toBeDefined();
  });

  it('reports a missing clip when the index is past the highlights', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({})]));

    renderDetail('5');

    expect(await screen.findByText(/Clip not found/i)).toBeDefined();
  });

  // Every dead end on this route replaces the whole page after the lazy chunk
  // has already announced "Loading…", so none of them may be silent, and none
  // of them may be a dead end in the literal sense either — the only other way
  // off this route is a breadcrumb.
  it('announces a failed load with the reason and a way out', async () => {
    vi.mocked(getProjectMetadata).mockRejectedValue(new Error('project.json is corrupt'));

    renderDetail('0');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('project.json is corrupt');
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /back to project/i })).toBeDefined();
  });

  it('announces a missing clip rather than only drawing it', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({})]));

    renderDetail('5');

    expect((await screen.findByRole('alert')).textContent).toMatch(/Clip not found/i);
  });

  // A hand-typed or stale URL reached the captions endpoint as `clip/NaN`
  // before the not-found branch ever rendered.
  it('does not request captions for a route index that is not a number', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({})]));

    renderDetail('not-a-number');

    await screen.findByRole('alert');
    expect(getClipCaptions).not.toHaveBeenCalled();
  });

  // The social copy is written by a later pipeline step. Four boxes holding
  // nothing but their own labels read as the feature being broken.
  it('says which step fills the written fields instead of rendering them blank', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'HOOK',
          video_title_for_youtube_short: undefined,
          video_description_for_x: undefined,
          video_description_for_reddit: undefined,
          video_description_for_linkedin: undefined,
        }),
      ])
    );

    renderDetail('0');

    // Matched on "Not written yet" rather than on the step: the YouTube
    // description below names the same step and is not one of these.
    expect((await screen.findAllByText(/Not written yet/i)).length).toBe(4);
  });

  it('falls back to naming the transcribe step when a highlight has no text', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([highlight({ viral_hook_text: 'HOOK', highlight_text: undefined })])
    );

    renderDetail('0');

    expect(await screen.findByText(/Run the Transcribe step/i)).toBeDefined();
  });

  // Publishing is outward-facing and cannot be undone from this app.
  it('does not upload to YouTube until the publish is confirmed', async () => {
    vi.mocked(uploadClip).mockResolvedValue({
      status: 'started',
      job: 'test-project_upload_clip_0',
    });
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'HOOK',
          video_title_for_youtube_short: 'A title viewers will see',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
        }),
      ])
    );

    renderDetail('0');

    fireEvent.click(await screen.findByRole('button', { name: /^upload to youtube$/i }));
    expect(uploadClip).not.toHaveBeenCalled();

    // The dialog quotes the title back, because that is what lands on the
    // channel and it was written by a model, not by the user.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('A title viewers will see');

    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(uploadClip).toHaveBeenCalledWith('test-project', 0);
  });

  it('leaves the clip unpublished when the confirmation is cancelled', async () => {
    vi.mocked(uploadClip).mockResolvedValue({
      status: 'started',
      job: 'test-project_upload_clip_0',
    });
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({ viral_hook_text: 'HOOK', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
      ])
    );

    renderDetail('0');

    fireEvent.click(await screen.findByRole('button', { name: /^upload to youtube$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    expect(uploadClip).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The clip is cut on its way up, so there is nothing to render first and
  // nothing to gate the button on.
  it('offers to publish a clip the clipper has never cut', async () => {
    vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({ viral_hook_text: 'HOOK' })]));

    renderDetail('0');

    const button = await screen.findByRole('button', { name: /^upload to youtube$/i });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  // The job leaves /active_processes whether it published anything or not, so
  // the highlight is what says which happened.
  it('reports the upload as done once the clip says it was published', async () => {
    vi.mocked(uploadClip).mockResolvedValue({
      status: 'started',
      job: 'test-project_upload_clip_0',
    });
    const published = highlight({
      viral_hook_text: 'HOOK',
      is_clip_generated: true,
      generated_clip_filename: 'first.mp4',
      youtube_url: 'https://youtu.be/abc123',
      uploaded_at: '2026-08-20T11:00:00',
    });
    vi.mocked(getProjectMetadata)
      // What the page holds when the upload starts: never published.
      .mockResolvedValueOnce(project([highlight({
        viral_hook_text: 'HOOK',
        is_clip_generated: true,
        generated_clip_filename: 'first.mp4',
      })]))
      .mockResolvedValue(project([published]));

    renderDetail('0');

    fireEvent.click(await screen.findByRole('button', { name: /^upload to youtube$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^upload$/i }));

    expect((await screen.findByRole('status')).textContent).toContain('Uploaded to YouTube');
  });

  it('shows why a finished upload published nothing', async () => {
    vi.mocked(uploadClip).mockResolvedValue({
      status: 'started',
      job: 'test-project_upload_clip_0',
    });
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({
          viral_hook_text: 'HOOK',
          is_clip_generated: true,
          generated_clip_filename: 'first.mp4',
          // Written by whichever part gave up — here, the cut that precedes it.
          upload_error: 'The source video for this project is missing.',
        }),
      ])
    );

    renderDetail('0');

    fireEvent.click(await screen.findByRole('button', { name: /^upload to youtube$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^upload$/i }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The source video for this project is missing.'
    );
  });

  it('interrupts with a reachable reason when the upload cannot be started', async () => {
    vi.mocked(uploadClip).mockRejectedValue(new TypeError('Failed to fetch'));
    vi.mocked(getProjectMetadata).mockResolvedValue(
      project([
        highlight({ viral_hook_text: 'HOOK', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
      ])
    );

    renderDetail('0');

    fireEvent.click(await screen.findByRole('button', { name: /^upload to youtube$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^upload$/i }));

    // Not the raw `Failed to fetch`, which names nothing the user can act on.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not reach the server');
    fireEvent.click(screen.getByRole('button', { name: /dismiss message/i }));
    expect(screen.queryByText(/Could not reach the server/i)).toBeNull();
  });

  // Re-cutting one clip is what turns a caption or title change into a file,
  // and it is the only action here that works before anything has been
  // rendered at all.
  describe('regenerating the clip', () => {
    it('re-cuts a clip that has already been rendered', async () => {
      vi.mocked(regenerateClip).mockResolvedValue({ status: 'started', job: 'test-project_clip_0' });
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({ viral_hook_text: 'HOOK', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
        ])
      );

      renderDetail('0');

      fireEvent.click(await screen.findByRole('button', { name: /^regenerate clip$/i }));
      expect(regenerateClip).toHaveBeenCalledWith('test-project', 0);
      // The encode outlives the request, so the button reports that it is
      // running rather than falling straight back to its resting label.
      expect(await screen.findByRole('button', { name: /rendering this clip/i })).toBeDefined();
    });

    it('offers to render a clip the clipper has never cut', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({ viral_hook_text: 'HOOK' })]));

      renderDetail('0');

      const button = await screen.findByRole('button', { name: /^render this clip$/i });
      expect(button.hasAttribute('disabled')).toBe(false);
    });

    it('says why the render could not be started', async () => {
      vi.mocked(regenerateClip).mockRejectedValue(new TypeError('Failed to fetch'));
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({ viral_hook_text: 'HOOK', is_clip_generated: true, generated_clip_filename: 'first.mp4' }),
        ])
      );

      renderDetail('0');

      fireEvent.click(await screen.findByRole('button', { name: /^regenerate clip$/i }));
      expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server');
    });

    it('plays the new cut rather than the copy the browser already has', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({
            viral_hook_text: 'HOOK',
            is_clip_generated: true,
            generated_clip_filename: 'first.mp4',
            rendered_at: '2026-08-20T10:00:00',
          }),
        ])
      );

      renderDetail('0');

      const video = await screen.findByLabelText('HOOK');
      expect(video.getAttribute('src')).toContain('?v=2026-08-20T10:00:00');
    });
  });

  describe('overlay text', () => {
    it('opens an editor for a clip that has no title yet', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({ viral_hook_text: 'HOOK' })]));

      renderDetail('0');

      fireEvent.click(await screen.findByRole('button', { name: /^add overlay text$/i }));
      expect(await screen.findByRole('dialog')).toBeDefined();
      expect(screen.getByLabelText(/^text$/i)).toBeDefined();
    });

    it('saves what is typed against the clip', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(project([highlight({ viral_hook_text: 'HOOK' })]));

      renderDetail('0');

      fireEvent.click(await screen.findByRole('button', { name: /^add overlay text$/i }));
      fireEvent.change(screen.getByLabelText(/^text$/i), { target: { value: 'Cold open' } });

      await vi.waitFor(() =>
        expect(updateClipOverlay).toHaveBeenCalledWith(
          'test-project',
          0,
          expect.objectContaining({ text: 'Cold open', enabled: true, start: 0 })
        )
      );
    });

    it('draws a stored title over the player', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({
            viral_hook_text: 'HOOK',
            is_clip_generated: true,
            generated_clip_filename: 'first.mp4',
            overlay: { ...overlayText, text: 'Cold open' },
            overlay_burned: false,
          }),
        ])
      );
      vi.mocked(getClipCaptions).mockResolvedValue(
        captionsWith({ ...overlayText, text: 'Cold open' }, false)
      );

      renderDetail('0');

      expect(await screen.findByText('Cold open')).toBeDefined();
    });

    it('does not draw a title the rendered file already carries', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({
            viral_hook_text: 'HOOK',
            is_clip_generated: true,
            generated_clip_filename: 'first.mp4',
            overlay: { ...overlayText, text: 'Cold open' },
            overlay_burned: true,
          }),
        ])
      );
      vi.mocked(getClipCaptions).mockResolvedValue(
        captionsWith({ ...overlayText, text: 'Cold open' }, false)
      );

      renderDetail('0');

      // It is in the file's own pixels; drawing it again would double it.
      await screen.findByLabelText('HOOK');
      expect(screen.queryByText('Cold open')).toBeNull();
    });

    it('says a saved title is not in the rendered file until the clip is re-cut', async () => {
      vi.mocked(getProjectMetadata).mockResolvedValue(
        project([
          highlight({
            viral_hook_text: 'HOOK',
            is_clip_generated: true,
            generated_clip_filename: 'first.mp4',
            overlay: { ...overlayText, text: 'Cold open' },
            overlay_burned: false,
          }),
        ])
      );
      vi.mocked(getClipCaptions).mockResolvedValue(
        captionsWith({ ...overlayText, text: 'Cold open' }, false)
      );

      renderDetail('0');

      expect(await screen.findByText(/Regenerate the clip to burn it in/i)).toBeDefined();
    });
  });
});
