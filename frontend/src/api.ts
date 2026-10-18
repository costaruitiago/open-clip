const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

/**
 * A caption style, as resolved by backend/src/services/caption_styles.py.
 *
 * Every size is a percentage of the output frame rather than a pixel value,
 * which is what lets the preview overlay and the burned ASS render agree while
 * drawing at completely different sizes.
 */
export type CaptionStyle = {
  label: string;
  description: string;
  animation: 'karaoke' | 'word' | 'static';
  words_per_cue: number;
  font_family: string;
  font_size_pct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  text_color: string;
  active_color: string;
  outline_color: string;
  shadow_color: string;
  box_color: string | null;
  outline_pct: number;
  shadow_pct: number;
  position_pct: number;
  max_width_pct: number;
  active_scale: number;
};

export type CaptionSettings = {
  enabled: boolean;
  preset: string;
  overrides: Partial<CaptionStyle>;
};

export type CaptionWord = { text: string; start: number; end: number };

/** Cue times are relative to the start of the clip, not the source video. */
export type CaptionCue = { start: number; end: number; text: string; words: CaptionWord[] };

/**
 * The face the clipper will burn with, as resolved by fontconfig on the
 * backend. The overlay loads `url` rather than trusting the family name to mean
 * the same thing here as it does there.
 */
export type CaptionFont = {
  family: string;
  /** Ascent-to-descent height per em: the line-height libass will use. */
  height_ratio: number;
  /** Path on this API, or null when the backend could not resolve a file. */
  url: string | null;
};

/**
 * A title drawn over one clip, as stored by backend/src/dataclasses/data.py.
 *
 * Independent of the captions: this is text the user wrote for this clip, shown
 * from `start` (0 by default — the top of the clip) for `duration` seconds and
 * faded out. Times are seconds from the start of the clip. Sizes are
 * percentages of the output frame, the same contract a caption style uses, so
 * the preview overlay and the burned render draw the same thing.
 */
export type OverlayText = {
  enabled: boolean;
  text: string;
  start: number;
  duration: number;
  fade_in: number;
  fade_out: number;
  font_family: string;
  font_size_pct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  text_color: string;
  outline_color: string;
  outline_pct: number;
  /** A hard offset shadow, down and right, no blur. Zero draws none. */
  shadow_color: string;
  shadow_pct: number;
  /** What a `*marked*` word is drawn in. Unused by a title with no marks. */
  highlight_color: string;
  box_color: string | null;
  /** Distance from the top of the frame, unlike a caption's, measured up from the bottom. */
  position_pct: number;
  max_width_pct: number;
};

/**
 * What a new title starts from, mirroring `OverlayText` in
 * backend/src/dataclasses/data.py.
 *
 * Kept in step by the backend itself: every save comes back sanitized, so a
 * value that drifts here is corrected on the next round trip.
 */
export const DEFAULT_OVERLAY_TEXT: OverlayText = {
  enabled: true,
  text: '',
  start: 0,
  duration: 3,
  // Zero, so the title is fully there on the first frame. A fade in is
  // something to ask for, not something a new title arrives with.
  fade_in: 0,
  fade_out: 0.6,
  font_family: 'Arial Black',
  // As large as the frame allows rather than as large as possible: a word
  // wider than the frame is cut off by the burn, not wrapped.
  font_size_pct: 8,
  bold: true,
  italic: false,
  uppercase: true,
  text_color: '#FFFFFF',
  outline_color: '#000000',
  // Heavy, because the background is always moving footage rather than a flat
  // colour.
  outline_pct: 0.9,
  // A title arrives with a shadow rather than being offered one: it is the
  // difference between text sitting over the picture and text printed onto it.
  shadow_color: '#000000',
  shadow_pct: 0.8,
  // Only drawn where a word is marked. Yellow because that is the pairing that
  // measures best against a dark ground, and the ground here is an outline and
  // a shadow that are both black by default.
  highlight_color: '#FFE000',
  box_color: null,
  position_pct: 12,
  max_width_pct: 86,
};

export type CaptionPreview = {
  enabled: boolean;
  style: CaptionStyle;
  font: CaptionFont;
  duration: number;
  cues: CaptionCue[];
  /**
   * The title this clip draws: its own when it has unlocked one, otherwise the
   * project's. Null only for a backend older than the project-level setting.
   */
  overlay: OverlayText | null;
  /** The face the title will be burned with. Null when there is no title. */
  overlay_font: CaptionFont | null;
  /** True when the title above is the project's rather than this clip's own. */
  overlay_locked: boolean;
  /** True when this clip follows the project rather than its own settings. */
  locked: boolean;
  /** The clip's own settings, or null while it is locked to the project. */
  settings: CaptionSettings | null;
};

/**
 * One moment the model picked out of the source.
 *
 * Only the window is guaranteed. Every other field is written by a later
 * pipeline step — the social copy by the video-meta task, the filename by the
 * clipper — so a project that has run the highlights step and nothing else
 * carries highlights with almost all of this missing. They are optional here so
 * that a view reading one has to decide what to show when it is absent, rather
 * than rendering `undefined` as a blank.
 */
/**
 * Jev's answers for one clip, each a probability from 0 to 1. `score` weights
 * them 50% hook, 40% attention, 10% stands alone; `relative` is that score
 * stretched across the video (its best moment 1, its weakest 0), which is what
 * the card shows and the cutoff is compared against. `tags` names the answers
 * at or above 0.8. The loop is not in the score: `loop` stays null until the
 * run has chosen this clip's cut, and `loop_used` says whether the clip ends
 * on a word that runs back into its opening.
 */
export type JevScores = {
  score: number;
  relative?: number;
  tags?: string[];
  hook?: number;
  standalone?: number;
  attention?: number;
  loop?: number | null;
  loop_used?: boolean;
};

export type Highlight = {
  start: number;
  end: number;
  highlight_text?: string;
  viral_hook_text?: string;
  video_title_for_youtube_short?: string;
  /** The model's description of this clip, before the template wraps it. */
  video_description_for_youtube_short?: string;
  video_description_for_x?: string;
  video_description_for_reddit?: string;
  video_description_for_linkedin?: string;
  is_clip_generated?: boolean;
  generated_clip_filename?: string | null;
  /** True when the file's own pixels already carry the captions. */
  captions_burned?: boolean;
  /** The title drawn over this clip, or null/absent for a clip with none. */
  overlay?: OverlayText | null;
  /** True when the file's own pixels already carry that title. */
  overlay_burned?: boolean;
  /** When the file was last written. The filename never changes, so this is
   *  what tells a browser holding the previous cut that there is a new one. */
  rendered_at?: string | null;
  /** The output settings the file was cut with, or absent for one cut before
   *  they were recorded. Changing the project's aspect ratio or resolution
   *  re-cuts nothing, so these are what say whether the file on disk is still
   *  the shape the project now asks for. */
  rendered_aspect_ratio?: string | null;
  rendered_resolution?: string | null;
  /** The layout the file was cut with, or absent for one cut before layouts
   *  existed — which was always a crop. */
  rendered_layout?: Layout | null;
  /** When the window was last moved, or absent for one nobody has trimmed. A
   *  trim re-cuts nothing, so a stamp later than `rendered_at` means the file
   *  on disk still holds the window before the edit. */
  trimmed_at?: string | null;
  /** What Jev answered about this clip, or absent for a clip Gemini picked. */
  jev_scores?: JevScores | null;
  /** Where this clip was published, once it has been uploaded to YouTube. */
  youtube_video_id?: string | null;
  youtube_url?: string | null;
  uploaded_at?: string | null;
  /** What the video is on YouTube, and — for a scheduled one — when YouTube
   *  turns it public. The only thing that distinguishes a scheduled short from
   *  a private one: they are the same page until the hour comes. Absent for a
   *  clip published before an upload could be anything but private. */
  youtube_privacy?: UploadPrivacy | null;
  youtube_publish_at?: string | null;
  /** Why the last publish attempt produced no video, or absent when it did.
   *  The upload runs in the background, so this is where its outcome is read
   *  from rather than from the response to the click that started it. */
  upload_error?: string | null;
  /** The Postiz post this clip was imported as, once it has been. Separate from
   *  the YouTube record because they are different destinations for the same
   *  clip: YouTube is published from here, Postiz is a draft somebody still has
   *  to send, and a clip can legitimately be in both. */
  postiz_post_id?: string | null;
  postiz_url?: string | null;
  postiz_imported_at?: string | null;
  /**
   * Which channels the last import filed against, and what Postiz has since
   * done with each. `state` and `url` appear only after a sync, and `url` is
   * the post on the platform itself — the one link worth following once
   * something is actually out.
   */
  postiz_channels?: {
    id: string;
    name?: string;
    platform?: string;
    state?: string | null;
    url?: string | null;
    /** Added to the post in Postiz rather than by this app. */
    added_in_postiz?: boolean;
  }[];
  /**
   * What Postiz has done with the post: `published`, `scheduled`, `error`, or
   * absent for one it will not talk about — which is every draft, because its
   * public API returns none. Absent therefore means "not sent, or deleted, and
   * Postiz will not say which", never "gone".
   */
  postiz_state?: string | null;
  postiz_synced_at?: string | null;
  /** Why the last import filed nothing, or absent when it worked. Read the same
   *  way `upload_error` is: the import runs in the background. */
  postiz_error?: string | null;
};

/**
 * What a project contributes to the YouTube description of its clips.
 *
 * `source_url` is the full episode the shorts were cut from; it becomes a link
 * in every description. It is not YouTube's "Related video" chip, which the
 * Data API cannot set — see `getStudioEditUrl`.
 * Empty `text`/`template` mean "use the application-wide ones".
 */
export type DescriptionSettings = {
  source_url: string;
  source_title: string;
  text: string;
  template: string;
};

/**
 * Where one project's clips are imported, when it differs from the app's.
 *
 * `channels` is null while the project has no opinion and follows Settings —
 * which is not the same as `[]`, a project that has chosen to import nowhere.
 * `channel_settings` is layered over the application's per channel, so a
 * project can post to a different Discord channel without restating the rest.
 */
export type PostizProjectSettings = {
  channels: string[] | null;
  post_type: 'draft' | 'schedule' | 'now' | null;
  channel_settings: Record<string, Record<string, string>>;
  /** How many of this project's clips land per day. 0 is all at once, null follows Settings. */
  per_day: number | null;
  /**
   * The rest of the calendar, shaped exactly like the YouTube one and read by
   * the same arithmetic: the day the run begins as YYYY-MM-DD, and the hours a
   * day's posts are spread between. Null follows Settings.
   */
  start_date: string | null;
  day_start_hour: number | null;
  day_end_hour: number | null;
  /** What each post says, and what goes under it. Empty follows Settings. */
  text_template: string;
  comment_template: string;
};

/**
 * What an upload makes on YouTube.
 *
 * `schedule` is not a fourth privacy — YouTube has no such state. It is
 * private plus a publish time, which YouTube itself turns public when the hour
 * comes. It is offered as a fourth choice because that is how it is thought
 * about, and the backend takes it apart again.
 */
export type UploadPrivacy = 'private' | 'unlisted' | 'public' | 'schedule';

/**
 * How this project's clips go up on YouTube, when that differs from the app's.
 *
 * Every field is null while the project has no opinion, which is what keeps
 * the default live: change it in Settings and a project that never chose
 * follows it. The four schedule fields mean nothing unless `privacy` is
 * `schedule`, and are kept anyway — a week on private should not cost the user
 * the calendar they typed.
 */
export type UploadProjectSettings = {
  privacy: UploadPrivacy | null;
  /** How many clips are published per day. 0 is all at the same moment. */
  per_day: number | null;
  /** The day the schedule begins, as YYYY-MM-DD. */
  start_date: string | null;
  /** The hours the day's clips are spread between, on this machine's clock. */
  day_start_hour: number | null;
  day_end_hour: number | null;
};

/**
 * What a project asks the highlights prompt for, when it differs from the app's.
 *
 * The prompt used to state how many segments to find and how long they may run
 * in its own text, which made every project a podcast cut into 7–12 shorts. A
 * two-hour interview and a ten-minute talk do not hold the same number of good
 * moments, so these are settings.
 *
 * Every number is null while the project has no opinion, which keeps the
 * application default live: change it in Settings and a project that never
 * chose follows it. `guidance` is free text added to the prompt — what this
 * project counts as a highlight — and empty means the same thing null does.
 */
export type HighlightProjectSettings = {
  /** How many segments a run returns, at least and at most. */
  min_clips: number | null;
  max_clips: number | null;
  /** How long one may run, in seconds. Hard limits, not preferences. */
  min_duration: number | null;
  max_duration: number | null;
  /** Extra instructions for this project, in the user's own words. */
  guidance: string;
  /** The Jev score a clip needs to be one of this project's clips, or
   *  null/absent to follow the application's `jev_min_score`. */
  jev_min_score?: number | null;
};

/** How a widescreen source fills a taller frame. */
export type Layout = 'crop' | 'stacked' | 'split';

/** One placeholder a description template may use, as described by the backend. */
export type DescriptionField = { field: string; description: string };

/**
 * One title the metadata step wrote for the whole video, with the posts that
 * go with it. `summary` is the video's description and is the same sentence on
 * every title — the prompt returns one summary for the video, not one per
 * title.
 */
export type VideoTitle = {
  index: number;
  title: string;
  summary: string;
  post_for_x: string;
  post_for_reddit: string;
  post_for_linkedin: string;
  /** Why this title was picked as one of the best, or empty for the rest. */
  reason: string;
};

/** What the metadata step wrote about the video as a whole. */
export type VideoMetadata = {
  components: VideoTitle[];
  /** The best titles, by position in `components`. */
  top_recommendations: { index?: number; reason?: string }[];
};

export type ProjectMetadata = {
  project_id: string;
  name: string;
  created_at: string;
  // Cut clips are not a separate array: they are the highlights with
  // `is_clip_generated`, in that order.
  highlights: Highlight[];
  /** Titles and a description for the whole video, from the Metadata step. */
  video_metadata?: VideoMetadata;
  // Output of prompt-defined LLM tasks that have no typed field, keyed by task name.
  llm_outputs?: Record<string, unknown>;
  clips_count?: number;
  step_statuses?: Record<string, string>;
  settings?: {
    resolution?: string;
    aspect_ratio?: string;
    captions?: CaptionSettings;
    /**
     * The standing title every clip draws unless it has unlocked its own. Like
     * the captions, this is the project's copy: a clip inherits it until it
     * saves one of its own.
     */
    overlay?: OverlayText;
    description?: DescriptionSettings;
    /** What this project asks a highlights run for, when it differs from the app's. */
    highlights?: HighlightProjectSettings;
    /**
     * How a widescreen source fills a taller frame: cropped around the
     * subject, kept whole between darkened copies of itself, or cut into a
     * left and a right part stacked one above the other.
     */
    layout?: Layout;
    /** How dark the stacked bands are, 0 (untouched) to 100 (black). */
    stack_darkness?: number;
    /** Where the split layout cuts the source, as a percentage of its width (20-80). */
    split_position?: number;
    /** Split layout: the right part on top instead of the left. */
    split_swap?: boolean;
    /** Split layout: a line along the seam. */
    split_divider?: boolean;
    /** Where this project's clips are imported, when it differs from the app's. */
    postiz?: PostizProjectSettings;
    /** How this project's clips go up on YouTube, when it differs from the app's. */
    upload?: UploadProjectSettings;
  };
  files?: {
    original_file?: string;
  };
};

export type SettingsResponse = {
  settings: {
    gemini_api_key?: string;
    youtube_client_secrets?: any;
    codec?: string;
    theme?: 'light' | 'dark';
    video_defaults?: {
      resolution: string;
      aspect_ratio: string;
    };
    // Where a new project's caption settings start. Changing it never touches
    // projects that already exist.
    caption_defaults?: Partial<CaptionSettings>;
    // Where a new project's title look starts — font, size, placement, colours,
    // timing — and, like the project setting it seeds, never any words.
    overlay_defaults?: Partial<OverlayText>;
    // What every highlights run asks for unless a project disagrees: how many
    // segments, how long they may be, and any standing instructions. Unlike the
    // three defaults above this is read when the step runs, so editing it
    // changes what an existing project finds on its next run.
    highlight_defaults?: Partial<HighlightProjectSettings>;
    // The language the video is in, as a Whisper code, or "auto" to detect it.
    // Absent means English.
    transcription_language?: string;
    // Which model finds the highlights. Jev picks and cuts the clips; Gemini
    // still writes their titles. Absent means Gemini.
    highlight_provider?: 'gemini' | 'jev';
    // Clips scoring under this, relative to their video (0–1), go under "show
    // more" for every project that has not set its own.
    jev_min_score?: number;
    // The text and template every project's descriptions start from. Unlike
    // caption defaults these are read at upload time, so editing them changes
    // what existing projects publish.
    description_defaults?: { text?: string; template?: string };
    // Where clips are imported to be posted from, and how. The key is a secret
    // and comes back the way the Gemini key does; the rest is plain settings.
    // What every upload makes unless a project disagrees. `private` — the
    // default — is the only one of the four that cannot reach an audience by
    // accident, and is what an upload did before there was a choice.
    youtube_privacy?: UploadPrivacy;
    // The schedule a `schedule` upload publishes on, read on this machine's
    // clock. Only these three shape it: how many clips a day, the day it
    // starts, and the hours of that day they are spread between.
    youtube_schedule_per_day?: number;
    youtube_schedule_start_date?: string;
    youtube_schedule_day_start_hour?: number;
    youtube_schedule_day_end_hour?: number;
    postiz_api_key?: string;
    postiz_api_url?: string;
    // Jev, TypeSafe AI's decision model. The key is a secret like the Gemini
    // key; the URL is empty unless calls go through a gateway.
    typesafe_api_key?: string;
    typesafe_api_url?: string;
    // Which channels an import files against. Empty means nothing is imported:
    // posting somewhere is a decision, not something to infer from an account
    // being connected to Postiz.
    postiz_channels?: string[];
    // Anything a platform needs that only the user knows — a Discord channel
    // id, a subreddit — keyed by the channel's own id.
    postiz_channel_settings?: Record<string, Record<string, string>>;
    // What an import makes. `draft` — the default — reaches nobody.
    postiz_post_type?: 'draft' | 'schedule' | 'now';
    // Whether each clip is filed the moment the clipper finishes cutting it,
    // rather than in one pass at the end of the project. Default on.
    postiz_import_on_render?: boolean;
    postiz_schedule_offset_minutes?: number;
    // How many clips land per day. 0 — the default — is all of them at once.
    postiz_per_day?: number;
    // The day the run begins, read on this machine's clock. Empty is "as soon
    // as a post may be placed", which is the offset ahead of now. The same
    // question the YouTube schedule asks, because the two answer to one
    // calendar.
    postiz_schedule_start_date?: string;
    // The hours a day's posts are spread between, first and last.
    postiz_day_start_hour?: number;
    postiz_day_end_hour?: number;
    // What every post says, in the same template language the YouTube
    // description uses. Empty means the model's words for that platform.
    postiz_text_template?: string;
    // What goes in the comment under each post. The usual reason is the link:
    // platforms bury a post that carries an outbound URL.
    postiz_comment_template?: string;
  };
  pipeline_config: {
    execution_order: string[];
    steps: Record<string, { auto_run: boolean }>;
  };
};

async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  return response.json();
}

export const createProject = async (
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ project_id: string }> => {
  // 1. Init project metadata. Resolution and aspect ratio are not sent: the
  // project starts on the application defaults and both are changed in Project
  // settings afterwards, against the previews.
  const initResponse = await fetch(`${BASE_URL}/project/init`, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name
    })
  });
  const { project_id } = await initResponse.json();

  // 2. Upload file
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/project/upload/${project_id}`);
    
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        onProgress(percentComplete);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ project_id });
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
        console.error('XHR Upload Error');
        reject(new Error('Network error during upload'));
    };
    xhr.send(file);
  });
};

export const getStepStatus = async (projectId: string, step: string): Promise<{ status: string }> => {
  return apiRequest(`/project/${projectId}/step_status/${step}`);
};

export const processProject = async (projectId: string) => {
  return apiRequest('/project/process', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId }),
  });
};

export const getProjects = async (): Promise<ProjectMetadata[]> => {
  return apiRequest('/projects');
};

export const getProjectMetadata = async (projectId: string): Promise<ProjectMetadata> => {
  return apiRequest<ProjectMetadata>(`/project/${projectId}`);
};

// Timeline marker EDL for DaVinci Resolve. `recordStart` must match the
// timecode the Resolve timeline starts at (default 01:00:00:00).
export const getMarkerEdlUrl = (projectId: string, recordStart = '01:00:00:00') => {
  return `${BASE_URL}/project/${projectId}/markers.edl?start=${encodeURIComponent(recordStart)}`;
};

/**
 * The filename the server named the attachment, or null when it did not say.
 *
 * Cross-origin, this header is only readable because the backend lists it in
 * `Access-Control-Expose-Headers`; every caller still needs a fallback name for
 * the case where it is not there.
 */
const filenameFromResponse = (response: Response): string | null => {
  const disposition = response.headers.get('Content-Disposition');
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
};

/** Hands a fetched body to the browser as a file, then releases it. */
const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next frame rather than immediately: Safari has not always
  // finished reading the object URL by the time click() returns.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
};

/**
 * Downloads the marker EDL through fetch rather than by following the link.
 *
 * The plain `<a download>` works only on the happy path. The API is a
 * different origin from the app, so `download` is ignored and the click is a
 * top-level navigation — and on a failure the backend answers with a JSON
 * error, which the browser renders as a page. The export then costs the user
 * the whole app. Fetching it means a failure is an error message on the page
 * that asked for it, and the anchor is still there for middle-click.
 */
export const downloadMarkerEdl = async (
  projectId: string,
  fallbackName: string,
  recordStart?: string
): Promise<void> => {
  const response = await fetch(getMarkerEdlUrl(projectId, recordStart));

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Export failed with status ${response.status}`);
  }

  saveBlob(await response.blob(), filenameFromResponse(response) ?? `${fallbackName}_markers.edl`);
};

// Chapter exports. `recordStart` must match the timecode the Resolve timeline
// starts at, same rule as the highlight markers above.
export const getChapterEdlUrl = (projectId: string, recordStart = '01:00:00:00') => {
  return `${BASE_URL}/project/${projectId}/chapters.edl?start=${encodeURIComponent(recordStart)}`;
};

export const getChapterTextUrl = (projectId: string) => {
  return `${BASE_URL}/project/${projectId}/chapters.txt`;
};

export type PipelineConfig = {
  execution_order: string[];
  // `llm` marks a step backed by a prompt file; those are collapsed behind a
  // single button in the pipeline controls.
  steps?: Record<string, { auto_run: boolean; llm?: boolean }>;
};

export const getPipelineConfig = async (): Promise<PipelineConfig> => {
  return apiRequest<PipelineConfig>('/pipeline/config');
};

// The values matter, not just the names: the clip preview has to work out the
// exact frame the clipper will render, which needs "9:16" and "1920x1080".
export const getResolutionMap = async (): Promise<Record<string, string>> => {
  return apiRequest<Record<string, string>>('/resolutions');
};

export const getAspectRatioMap = async (): Promise<Record<string, string>> => {
  return apiRequest<Record<string, string>>('/aspect_ratios');
};

/**
 * What one running step is doing, from `/execution_status`.
 *
 * `since` is always there — it is when the step was triggered, and a step that
 * has said nothing yet can still say how long it has been going. `message` only
 * appears once something inside the step has reported: which model is being
 * waited on, why it is being retried, which one it fell back to.
 */
export type StepActivity = {
  /** Epoch seconds, from the backend's clock. */
  since: number;
  message?: string;
  /** Epoch seconds when `message` was recorded. */
  at?: number;
};

export const getExecutionStatus = async (projectId: string): Promise<Record<string, string>> => {
  return apiRequest(`/project/${projectId}/execution_status`);
};

export const getSourceVideoUrl = (projectId: string, originalFile: string) => {
  return `${BASE_URL}/projects/static/${projectId}/${originalFile.split('/').pop()}`;
};

/**
 * A rendered clip's file.
 *
 * `version` is the highlight's `rendered_at`. A re-cut clip keeps its filename,
 * so without it the browser plays the copy it already has and a regenerated
 * clip looks like nothing happened.
 */
export const getClipVideoUrl = (projectId: string, filename: string, version?: string | null) => {
  const url = `${BASE_URL}/projects/static/${projectId}/clips/${filename}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
};

/**
 * Where a published clip is edited on YouTube.
 *
 * A Short's "Related video" — the chip that takes a viewer to the full episode
 * — has no field in the Data API and can only be set in Studio, so an upload
 * from here cannot attach it. The link in the description is a different thing.
 * This is the page that does have the control.
 */
/**
 * Whether this clip's published video is still on YouTube.
 *
 * Nothing tells this application when a video it published is deleted, so the
 * record outlives the video: a dead link on the clip page. Asked when a clip is opened; a video that has gone
 * takes its record with it on the server, so the answer is also the fix.
 *
 * `checked` is false when the question could not be asked — no channel
 * connected, no read scope, no network. That is not a "no", and nothing is
 * cleared on the strength of it.
 */
export type ClipPublication = {
  published: boolean;
  video_id: string | null;
  url: string | null;
  checked: boolean;
};

export const getClipPublication = async (
  projectId: string,
  clipIndex: number
): Promise<ClipPublication> =>
  apiRequest<ClipPublication>(`/project/${projectId}/clip/${clipIndex}/publication`);

export const getStudioEditUrl = (videoId: string) =>
  `https://studio.youtube.com/video/${videoId}/edit`;

/**
 * What Postiz says became of this project's posts, per clip index.
 *
 * `checked: false` means it could not be asked — no key, no network, nothing
 * filed yet — and carries the reason. `known: false` on a clip means Postiz
 * would not say: its public API returns no drafts at all, so a post that is
 * absent has either not gone out or has been deleted, and neither this app nor
 * the page may claim which.
 */
export type PostizSync = {
  checked: boolean;
  reason?: string;
  synced_at?: string;
  clips: Record<string, { state: string | null; known: boolean }>;
};

/**
 * Asks Postiz what became of the drafts, and records it on the clips.
 *
 * Nothing tells this application when a draft is sent, so a clip that went out
 * an hour ago reads as "waiting in Postiz" until this is called. A GET that
 * writes, like the YouTube `publication` check: asking is also the correction.
 */
export const syncPostiz = async (projectId: string): Promise<PostizSync> =>
  apiRequest<PostizSync>(`/project/${projectId}/postiz/sync`);

export const getSettings = async () => {
  return apiRequest('/settings');
};

export const updateSettings = async (payload: { settings: any, pipeline_config?: any }) => {
  return apiRequest('/settings', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
};

/**
 * The state of the connected YouTube channel.
 *
 * `missing_scopes` is not a broken connection: a token authorised before a
 * scope was added still uploads. It is listed because one of those scopes is
 * what lets this application ask whether a video it published is still on
 * YouTube — without it a deleted video leaves its record behind, and the clip
 * page goes on offering a dead link.
 */
export type YoutubeStatus = {
  connected: boolean;
  reason?: string;
  expired?: boolean;
  has_refresh_token?: boolean;
  account?: string | null;
  missing_scopes?: string[];
  has_client_secrets: boolean;
  consent?: { pending: boolean; completed: boolean; cancelled: boolean; error: string | null };
  /** What an upload makes when a project has no opinion, so a project's own
   *  panel can name the default it is following. */
  privacy?: UploadPrivacy;
};

export const getYoutubeStatus = async (): Promise<YoutubeStatus> => {
  return apiRequest('/youtube/status');
};

/**
 * Starts a consent and returns the Google URL to open.
 *
 * The backend does not open it: for a backend in a container the browser that
 * has to do the consenting is not on the same machine as the process.
 *
 * A consent already waiting is ended to make room for this one, so this is
 * also how a user retries after closing the tab on the last attempt.
 */
export const connectYoutube = async (): Promise<{ authorization_url: string }> => {
  return apiRequest('/youtube/connect', { method: 'POST' });
};

/** Abandons a consent left waiting in a browser. */
export const cancelYoutubeConnect = async (): Promise<{ status: string }> => {
  return apiRequest('/youtube/connect/cancel', { method: 'POST' });
};

export const updateCodec = async (codec: string) => {
  return apiRequest('/settings/codec', {
    method: 'POST',
    body: JSON.stringify({ codec }),
  });
};

export const getActiveProcesses = async (): Promise<string[]> => {
  return apiRequest('/active_processes');
};

/**
 * `regenerate` is only meaningful for the upload step: every clip is re-cut and
 * its existing YouTube video replaced by the new one.
 */
export const executePipelineStep = async (
  projectId: string,
  step: string,
  action: 'START' | 'STOP',
  regenerate = false
) => {
  return apiRequest('/project/step', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, step, action, ...(regenerate ? { regenerate: true } : {}) }),
  });
};

/**
 * Cuts one clip afresh and publishes it.
 *
 * The clip is always re-rendered first, so what goes up is the clip as the page
 * shows it rather than whatever was cut before the last change to its captions
 * or title. That makes this an encode, which outlives a browser request, so it
 * resolves when the job has been registered — not when the video is live. Watch
 * the key it returns on `/active_processes`, then read the highlight for
 * `youtube_url` or `upload_error`.
 */
export const uploadClip = async (
  projectId: string,
  clipIndex: number
): Promise<{ status: string; job: string }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/upload`, {
    method: 'POST',
  });
};

export type PostizChannel = {
  id: string;
  name?: string;
  /** The platform Postiz posts to — `x`, `linkedin`, `youtube`, … */
  identifier?: string;
  picture?: string;
  /** Postiz will not send from this channel; its authorisation has lapsed. */
  disabled?: boolean;
};

export type PostizStatus = {
  /** Whether an API key has been saved. Nothing else here is asked without one. */
  configured: boolean;
  api_url: string;
  /** The channels an import goes to. Empty means no import happens at all. */
  selected_channels: string[];
  post_type: 'draft' | 'schedule' | 'now';
  /** Present only when the key worked — the listing is what proves it did. */
  channels?: PostizChannel[];
  /** Why the channels could not be read: a wrong key, or an unreachable host. */
  error?: string;
};

/**
 * Whether Postiz is configured, and which channels a clip would be imported to.
 *
 * One request rather than two, because "is the key right" and "what is
 * connected" have the same answer: a listing that worked.
 */
export const getPostizStatus = async (): Promise<PostizStatus> => {
  return apiRequest('/postiz/status');
};

/**
 * Cuts one clip afresh and files it in Postiz as a post ready to send.
 *
 * Like `uploadClip` it re-renders first, so it is an encode and resolves when
 * the job has been registered rather than when the post exists. Watch the key
 * it returns on `/active_processes`, then read the highlight for `postiz_url`
 * or `postiz_error`.
 *
 * Unlike `uploadClip` nothing reaches an audience: what this makes is a draft
 * on the user's own calendar.
 */
export const importClipToPostiz = async (
  projectId: string,
  clipIndex: number
): Promise<{ status: string; job: string }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/postiz`, {
    method: 'POST',
  });
};

export const getCaptionStyles = async (): Promise<Record<string, CaptionStyle>> => {
  return apiRequest<Record<string, CaptionStyle>>('/caption_styles');
};

// Cues and style for one highlight. The same two things the burned render uses,
// so the overlay drawn over the preview is what the clipper will produce.
export const getClipCaptions = async (projectId: string, clipIndex: number): Promise<CaptionPreview> => {
  return apiRequest<CaptionPreview>(`/project/${projectId}/clip/${clipIndex}/captions`);
};

// The font file itself, served by the API so the page draws with the same one
// libass will.
export const getCaptionFontUrl = (path: string) => `${BASE_URL}${path}`;

// The same captions as a subtitle file, sized for the frame it will sit on.
export const getClipCaptionsAssUrl = (projectId: string, clipIndex: number, width = 1080, height = 1920) => {
  return `${BASE_URL}/project/${projectId}/clip/${clipIndex}/captions.ass?width=${width}&height=${height}`;
};

// The description one clip would be uploaded with, rendered by the backend so
// the preview and the upload cannot say different things.
export const getClipDescription = async (
  projectId: string,
  clipIndex: number
): Promise<{ description: string; template: string }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/description`);
};

// The placeholders a description template may use, and the template the app
// ships with.
export const getDescriptionFields = async (): Promise<{
  fields: DescriptionField[];
  default_template: string;
}> => {
  return apiRequest('/description_fields');
};

export const updateProjectSettings = async (
  projectId: string,
  settings: {
    resolution?: string;
    aspect_ratio?: string;
    captions?: Partial<CaptionSettings>;
    overlay?: Partial<OverlayText>;
    description?: Partial<DescriptionSettings>;
    highlights?: Partial<HighlightProjectSettings>;
    layout?: Layout;
    stack_darkness?: number;
    split_position?: number;
    split_swap?: boolean;
    split_divider?: boolean;
    postiz?: Partial<PostizProjectSettings>;
    upload?: Partial<UploadProjectSettings>;
  }
) => {
  return apiRequest(`/project/${projectId}/settings`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
};

/**
 * One clip's caption settings, or `null` to put it back under the project's.
 *
 * The whole object is sent rather than a patch: a clip is either locked or
 * speaking for itself, and a partial update says nothing about which.
 */
export const updateClipCaptions = async (
  projectId: string,
  clipIndex: number,
  captions: CaptionSettings | null
) => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/captions`, {
    method: 'PUT',
    body: JSON.stringify({ captions }),
  });
};

/**
 * One clip's own title, or `null` to put it back under the project's.
 *
 * The whole object is sent rather than a patch, for the same reason the caption
 * settings are: the editor holds the whole form. What comes back is the stored
 * value after the backend has clamped it, which is what will actually be burned.
 *
 * `null` is the lock, not a delete: a clip that wants no title at all against a
 * project that has one keeps its own and switches it off.
 */
export const updateClipOverlay = async (
  projectId: string,
  clipIndex: number,
  overlay: OverlayText | null
): Promise<{ status: string; overlay: OverlayText | null; locked: boolean }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/overlay`, {
    method: 'PUT',
    body: JSON.stringify({ overlay }),
  });
};

/**
 * Where one clip starts and ends in the source, in seconds.
 *
 * Both numbers go together rather than a delta: the editor holds the window and
 * the user watches it while nudging an edge. What comes back is the window as
 * stored — `start` never goes below zero — plus the stamp that says the cut file
 * is now behind it, since saving a trim renders nothing.
 */
export const updateClipTrim = async (
  projectId: string,
  clipIndex: number,
  window: { start: number; end: number }
): Promise<{ status: string; start: number; end: number; trimmed_at: string }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/trim`, {
    method: 'PUT',
    body: JSON.stringify(window),
  });
};

/**
 * Re-cuts one clip with whatever its settings now say.
 *
 * Unlike `uploadClip` this returns as soon as the render has been queued — an
 * encode outlives a browser request. The `job` it answers with is a key on
 * `/active_processes`, which is gone once the new file is on disk.
 */
export const regenerateClip = async (
  projectId: string,
  clipIndex: number
): Promise<{ status: string; job: string }> => {
  return apiRequest(`/project/${projectId}/clip/${clipIndex}/regenerate`, {
    method: 'POST',
  });
};

export const deleteClip = async (projectId: string, clipIndex: number) => {
  const response = await fetch(`${BASE_URL}/project/${projectId}/clip/${clipIndex}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete clip');
  return { status: 'deleted' };
};

export const deleteProject = async (projectId: string) => {
  // fetch delete doesn't return data usually, but this satisfies the existing signature
  const response = await fetch(`${BASE_URL}/project/${projectId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete project');
  return { status: 'deleted' };
};
