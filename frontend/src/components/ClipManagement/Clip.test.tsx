import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Clip, type ClipData } from './Clip';
import { stubFrameSize } from '../../test/stubFrame';
import {
  getCaptionStyles,
  getClipCaptions,
  importClipToPostiz,
  uploadClip,
} from '../../api';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  // Each card asks for its own captions; these tests are about the player, so
  // the answer is "none", which is also what a project with no transcript gets.
  getClipCaptions: vi.fn().mockResolvedValue({ enabled: false, style: {}, duration: 0, cues: [] }),
  getCaptionStyles: vi.fn().mockResolvedValue({}),
  // Watched only while a job is running; an empty list means nothing is.
  getActiveProcesses: vi.fn().mockResolvedValue([]),
  // An upload answers with the key to watch: it cuts the clip before it
  // publishes it, which outlives the request.
  uploadClip: vi.fn().mockResolvedValue({
    status: 'started',
    job: 'test-project-123_upload_clip_0',
  }),
  // An import answers with a key too: it re-cuts the clip before it files it.
  importClipToPostiz: vi.fn().mockResolvedValue({
    status: 'started',
    job: 'test-project-123_postiz_clip_0',
  }),
}));

const SOURCE_URL = 'http://localhost:8000/projects/static/test-project-123/original.mp4';

const renderClip = (clip: ClipData, aspectRatio: number | null = null) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Clip
          projectId="test-project-123"
          clip={clip}
          sourceUrl={SOURCE_URL}
          aspectRatio={aspectRatio}
          onDelete={() => {}}
          playingClipIndex={null}
          setPlayingClipIndex={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );

const renderedClip: ClipData = {
  index: 0,
  original_start: 1.0,
  original_end: 3.0,
  // The card names the clip by what it would be published as; the transcript
  // is on the detail page, not here.
  title: 'How they lost it all',
  hook: 'THEY LOST EVERYTHING',
  text: 'Test clip text',
};

const previewClip: ClipData = { ...renderedClip, original_end: 65 };

/** Both halves of every state the card paints: the colour and the words. */
const statesOf = (element: HTMLElement) => ({
  background: element.style.backgroundColor,
  color: element.style.color,
});

describe('Clip Component', () => {
  // Colour on this card is semantic and inherited from the pipeline row:
  // accent is something happening now or an exception, success is a thing that
  // is finished and cannot be taken back. Every one of them carries words too,
  // because DESIGN.md does not allow status by colour alone.
  describe('state colour', () => {
    it('keeps the accent for a clip that is merely the exception', async () => {
      renderClip(renderedClip);

      // Following the project: the plain card, no colour at all.
      const button = await screen.findByLabelText('Caption settings, following the project');
      expect(statesOf(button).background).toBe('');
      expect(statesOf(button).color).toBe('var(--text)');
    });
  });

  // The card is always the preview. Swapping to the cut file when a render
  // landed reloaded the card mid-upload.
  it('previews a rendered clip from the source, not its cut file', () => {
    renderClip(renderedClip);

    const videoElement = document.querySelector('video');
    expect(videoElement?.getAttribute('src')).toBe(SOURCE_URL);
    // A rendered card carries no state pill: the picture playing from its own
    // start already says the file exists.
    expect(screen.queryByText('Rendered')).toBeNull();
  });

  // A card that renders while you watch used to swap its transport for the
  // browser's and change shape as it did so.
  it('gives a rendered clip the same transport as a preview', () => {
    const { unmount } = renderClip(renderedClip);
    const rendered = document.querySelector('video') as HTMLVideoElement;
    // The browser's own controls scrub differently and sit inside the picture.
    expect(rendered.hasAttribute('controls')).toBe(false);
    expect(screen.getByLabelText(/Position within How they lost it all/i)).toBeDefined();
    const renderedFrame = rendered.parentElement?.className;
    unmount();

    renderClip(previewClip);
    const preview = document.querySelector('video') as HTMLVideoElement;
    expect(preview.parentElement?.className).toBe(renderedFrame);
    expect(screen.getByLabelText(/Position within How they lost it all/i)).toBeDefined();
  });

  it('names the card by what the clip would be published as', () => {
    renderClip(renderedClip);
    expect(screen.getByText('How they lost it all')).toBeDefined();
    // The transcript belongs to the detail page. On a card it was the tallest
    // thing that was not the video, and it quoted the clip rather than naming it.
    expect(screen.queryByText(/Test clip text/)).toBeNull();
  });

  // The video meta step writes the title, so a project that has only found its
  // highlights has none — and a row of cards reading "Clip 1, Clip 2" names
  // nothing.
  it('falls back to the hook before the title has been written', () => {
    renderClip({ ...renderedClip, title: undefined });
    expect(screen.getByText('THEY LOST EVERYTHING')).toBeDefined();
  });

  it('falls back to the clip’s position when the model has written neither', () => {
    renderClip({ ...renderedClip, title: undefined, hook: undefined });
    expect(screen.getByText('Clip 1')).toBeDefined();
  });

  // Nothing is cut until the clipper runs, so a highlight is reviewed by
  // playing the source inside its window.
  it('previews an unrendered clip from the source video', () => {
    renderClip(previewClip);

    const videoElement = document.querySelector('video');
    expect(videoElement?.getAttribute('src')).toBe(SOURCE_URL);
    // Native controls would scrub the whole source, past the window's edges.
    expect(videoElement?.hasAttribute('controls')).toBe(false);
    // Neither a "Preview" pill nor a timecode: pipeline facts, not anything
    // that says whether the clip is worth posting.
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.queryByText('0:01–1:05')).toBeNull();
  });

  // The cut file is for uploading and posting only. Without a source there is
  // nothing to preview, even when a cut exists.
  it('never plays the cut file, even when the source is gone', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Clip
            projectId="test-project-123"
            clip={renderedClip}
            sourceUrl={null}
            aspectRatio={null}
            onDelete={() => {}}
            playingClipIndex={null}
            setPlayingClipIndex={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(document.querySelector('video')).toBeNull();
    expect(screen.getByText('No source video to preview from.')).toBeDefined();
  });

  it('boxes the preview to the ratio the clipper would render at', () => {
    renderClip(previewClip, 9 / 16);

    const frame = document.querySelector('video')?.parentElement;
    expect(frame?.style.aspectRatio.startsWith(String(9 / 16))).toBe(true);
    // Cropped to fill the target frame, the way crop-then-scale does.
    expect((document.querySelector('video') as HTMLVideoElement).style.objectFit).toBe('cover');
  });

  // The upload cuts the clip itself, so a highlight nobody has rendered is
  // publishable: the file is made on the way up rather than looked for.
  it('offers to upload a clip that has never been rendered', () => {
    renderClip(previewClip);

    const upload = screen.getByLabelText('Upload clip to YouTube') as HTMLButtonElement;
    expect(upload.disabled).toBe(false);
  });

  // A card is where clips are actually worked on, so everything the detail
  // page offers for one clip is reachable from it — including the guard on the
  // one action that leaves the app.
  describe('the actions the detail page has', () => {
    beforeEach(() => {
      vi.mocked(uploadClip).mockClear();
    });

    it('asks before publishing rather than uploading on the click', async () => {
      renderClip(renderedClip);

      fireEvent.click(screen.getByLabelText('Upload clip to YouTube'));

      expect(uploadClip).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toHaveTextContent(/How they lost it all/);
      fireEvent.click(screen.getByRole('button', { name: 'UPLOAD' }));
      await waitFor(() => expect(uploadClip).toHaveBeenCalledWith('test-project-123', 0));
    });

    it('warns that a published clip would get a second video, not a replacement', () => {
      renderClip({ ...renderedClip, youtubeUrl: 'https://youtu.be/vid-1', youtubeVideoId: 'vid-1' });

      fireEvent.click(screen.getByLabelText('Upload this clip to YouTube again'));

      expect(screen.getByRole('dialog')).toHaveTextContent(/adds a second video/);
    });

    it('makes no claim about a published clip still being there', () => {
      renderClip({ ...renderedClip, youtubeUrl: 'https://youtu.be/vid-1', youtubeVideoId: 'vid-1' });

      // The card makes no claim about YouTube: it cannot see a video deleted
      // there afterwards, so anything it said went stale silently. The upload
      // button's own warning is what is left.
      expect(screen.queryByRole('link', { name: /View on YouTube/ })).toBeNull();
      expect(screen.queryByText('Published')).toBeNull();
    });
  });


  // A project with twenty highlights is twenty cards, and every one of them
  // pointed a <video> at the same multi-gigabyte source on first paint.
  describe('deferred media', () => {
    let observed: Element[];
    let trigger: (() => void) | null;

    beforeEach(() => {
      observed = [];
      trigger = null;
      globalThis.IntersectionObserver = class {
        // Declared rather than a constructor parameter property, which
        // `erasableSyntaxOnly` in tsconfig rejects.
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
          trigger = () =>
            this.callback(
              observed.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
              this as unknown as IntersectionObserver
            );
        }
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof IntersectionObserver;
    });

    afterEach(() => {
      // Other suites rely on the absent-API path, which loads eagerly.
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    });

    it('mounts no video until the card comes near the viewport', () => {
      renderClip(previewClip);

      expect(document.querySelector('video')).toBeNull();
      // The reserved box keeps the arriving player from shifting the grid.
      expect(observed.length).toBe(1);
    });

    it('mounts the player once the card is approached', async () => {
      renderClip(previewClip);
      expect(document.querySelector('video')).toBeNull();

      await act(async () => {
        trigger!();
      });

      expect(document.querySelector('video')?.getAttribute('src')).toBe(SOURCE_URL);
    });
  });

  // Caption placement is a question about this footage — whether the words
  // clear a face or the platform's own UI — so the dialog that sets it has to
  // show the footage.
  describe('caption placement preview', () => {
    const EMPTY = { enabled: false, style: {}, duration: 0, cues: [] };
    const CAPTIONS = {
      enabled: true,
      style: {
        label: 'Karaoke Pop',
        description: '',
        animation: 'karaoke',
        words_per_cue: 4,
        font_family: 'Arial Black',
        font_size_pct: 10,
        bold: true,
        italic: false,
        uppercase: false,
        text_color: '#FFFFFF',
        active_color: '#FFE500',
        outline_color: '#000000',
        shadow_color: '#000000',
        box_color: null,
        outline_pct: 1,
        shadow_pct: 0.5,
        position_pct: 80,
        max_width_pct: 86,
        active_scale: 1.2,
      },
      font: { family: 'Arial Black', height_ratio: 1.4, url: null },
      duration: 2,
      cues: [
        {
          start: 0,
          end: 1,
          text: 'we lost it',
          words: [
            { text: 'we', start: 0, end: 0.3 },
            { text: 'lost', start: 0.3, end: 0.6 },
            { text: 'it', start: 0.6, end: 1 },
          ],
        },
      ],
      overlay: null,
      overlay_font: null,
      locked: true,
      settings: null,
    };

    beforeEach(() => {
      // The overlay is a percentage of its box, and jsdom has no layout.
      stubFrameSize(400);
      vi.mocked(getClipCaptions).mockResolvedValue(CAPTIONS as never);
      vi.mocked(getCaptionStyles).mockResolvedValue({});
    });

    afterEach(() => {
      vi.mocked(getClipCaptions).mockResolvedValue(EMPTY as never);
    });

    const openDialog = async () => {
      fireEvent.click(await screen.findByLabelText(/Caption settings/));
      return screen.getByRole('dialog');
    };

    it('plays the clip inside the dialog, with the captions drawn on it', async () => {
      renderClip(renderedClip, 9 / 16);
      const dialog = await openDialog();

      const video = dialog.querySelector('video');
      expect(video?.getAttribute('src')).toBe(SOURCE_URL);
      // Drawn where the burn would put them, not merely described by a slider.
      await waitFor(() => expect(within(dialog).getByText('lost')).toBeDefined());
    });

    it('says so when there is no video to place them against', async () => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <Clip
              projectId="test-project-123"
              clip={previewClip}
              sourceUrl={null}
              aspectRatio={null}
              onDelete={() => {}}
              playingClipIndex={null}
              setPlayingClipIndex={() => {}}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
      const dialog = await openDialog();

      expect(dialog.querySelector('video')).toBeNull();
      expect(within(dialog).getByText(/No video to place these captions against/)).toBeDefined();
    });
  });

  // Clips are cut on their way out, by the upload and the Postiz import.
  it('offers no render of its own', () => {
    renderClip(renderedClip);
    expect(screen.queryByLabelText(/render this clip/i)).toBeNull();
  });

  /**
   * The overlay title on the grid, which is where a project is actually looked
   * at: a title only visible on the detail page is a title you have to open
   * eight clips to check.
   */
  describe('overlay title', () => {
    // No cues: a title is drawn whether or not the clip has been transcribed.
    const NO_CUES = { enabled: false, style: {}, duration: 0, cues: [], locked: true, settings: null };

    const TITLED = {
      ...NO_CUES,
      overlay: {
        enabled: true,
        text: 'Cold open',
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
      overlay_font: { family: 'Arial Black', height_ratio: 1.4, url: null },
    };

    beforeEach(() => {
      stubFrameSize(400);
      vi.mocked(getClipCaptions).mockResolvedValue(TITLED as never);
    });

    afterEach(() => {
      // Other suites read the no-captions path, which is the module mock's own
      // answer; this one is the exception and puts it back.
      vi.mocked(getClipCaptions).mockResolvedValue(NO_CUES as never);
    });

    it('draws the saved title on the card', async () => {
      renderClip(renderedClip, 9 / 16);
      // Solid, not at the zero opacity its fade-in starts from: the card is
      // parked on the first frame, where the ramp has not begun.
      const title = await screen.findByText('Cold open');
      expect(title.parentElement).toHaveStyle({ opacity: '1' });
    });

    it('opens the title editor with the clip to place it against', async () => {
      renderClip(renderedClip, 9 / 16);
      fireEvent.click(await screen.findByLabelText('Edit overlay text'));

      const dialog = screen.getByRole('dialog');
      expect(dialog.querySelector('video')?.getAttribute('src')).toBe(SOURCE_URL);
    });
  });

  describe('importing into Postiz', () => {
    it('files the clip without asking, because nothing is published', async () => {
      renderClip(renderedClip);

      fireEvent.click(screen.getByLabelText('Import clip into Postiz'));

      // No confirmation, unlike the upload beside it: what this makes is a
      // draft on the user's own calendar.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(importClipToPostiz).toHaveBeenCalledWith('test-project-123', 0)
      );
      expect(uploadClip).not.toHaveBeenCalled();
    });

    // The grid is where a dozen clips are looked at in one pass, and "which of
    // these have actually gone out" is the question being asked during one.
    // Colour never says it alone: the label carries the state in words.
    it('says a clip is waiting, and that importing again makes a second draft', () => {
      renderClip({ ...renderedClip, postizUrl: 'https://postiz.example.com' });

      expect(
        screen.getByLabelText('Waiting in Postiz; import again to make a second draft')
      ).toBeInTheDocument();
    });

    it('says a clip is published, because importing it again posts it twice', () => {
      renderClip({
        ...renderedClip,
        postizUrl: 'https://postiz.example.com',
        postizState: 'published',
      });

      const button = screen.getByLabelText(
        'Published from Postiz; import again to post it a second time'
      );
      expect(button).toBeInTheDocument();
      expect(button.style.backgroundColor).toBe('var(--success)');
    });

    it('says when Postiz could not send one', () => {
      renderClip({
        ...renderedClip,
        postizUrl: 'https://postiz.example.com',
        postizState: 'error',
      });

      expect(
        screen.getByLabelText('Postiz could not send this clip; import again to retry')
      ).toBeInTheDocument();
    });

    it('leaves a clip nobody has imported as the plain button', () => {
      renderClip(renderedClip);

      const button = screen.getByLabelText('Import clip into Postiz');
      expect(button.style.backgroundColor).toBe('');
    });

    it('is offered for a clip nobody has rendered, because the import cuts it', () => {
      renderClip(previewClip);

      expect(screen.getByLabelText('Import clip into Postiz')).toBeEnabled();
    });
  });

});
