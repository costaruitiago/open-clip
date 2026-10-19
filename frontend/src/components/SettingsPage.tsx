import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings, getResolutionMap, getAspectRatioMap, getCaptionStyles, getDescriptionFields, getYoutubeStatus, connectYoutube, cancelYoutubeConnect, getPostizStatus, type SettingsResponse, type UploadPrivacy } from '../api';
import { useDebounce } from '../hooks/useDebounce';
import { DescriptionFieldHelp } from './DescriptionFieldHelp';
import { DateField } from './DateField';
import {
  HOURS,
  MAX_SCHEDULE_YEARS_AHEAD,
  PER_DAY_CHOICES,
  PRIVACY_LABELS,
  earliestScheduleDate,
  hourLabel,
  latestScheduleDate,
} from '../utils/uploadSchedule';
import {
  MAX_HIGHLIGHT_CLIPS,
  MAX_HIGHLIGHT_DURATION,
  SHIPPED_HIGHLIGHT_DEFAULTS,
  type HighlightNumberField,
} from '../utils/highlightOptions';

/** Fields that mean something in a Postiz post and nothing in a description. */
const POSTIZ_FIELDS = [
  { field: 'platform.post', description: "What the model wrote for the platform this post is going to" },
  { field: 'platform.name', description: 'The platform itself, e.g. x, linkedin' },
];

/** Languages offered for transcription, as Whisper codes. "auto" lets Whisper guess. */
const TRANSCRIPTION_LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['pt', 'Portuguese'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['auto', 'Detect automatically'],
];

/**
 * One tab per feature. The page used to be every setting in one scroll, and
 * finding the Postiz channels meant reading past the YouTube schedule.
 */
const TABS = [
  ['general', 'General'],
  ['secrets', 'Secrets'],
  ['video', 'Video'],
  ['highlights', 'Highlights'],
  ['youtube', 'YouTube'],
  ['postiz', 'Postiz'],
  ['pipeline', 'Pipeline'],
] as const;

type Tab = (typeof TABS)[number][0];

const inputStyle: React.CSSProperties = {
  padding: 'var(--space-md)',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: 'var(--border)',
  fontFamily: 'inherit',
  width: '100%',
};

// Labels are bold but not uppercase: uppercase belongs to the card titles, so
// a group and a field inside it no longer look alike.
const labelStyle: React.CSSProperties = { fontWeight: 'bold', fontSize: '0.9rem' };
const hintStyle: React.CSSProperties = { fontSize: '0.8rem', opacity: 0.6 };
const errorStyle: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--error)', fontWeight: 'bold' };
const buttonStyle: React.CSSProperties = {
  padding: 'var(--space-xs) var(--space-sm)',
  minHeight: '44px',
  fontWeight: 'bold',
  textTransform: 'uppercase',
  fontSize: '0.8rem',
  alignSelf: 'flex-start',
};

/** A titled group of related fields. Every group on the page is one of these. */
const Card: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', border: 'var(--border)', padding: 'var(--space-md)' }}>
    <h3 style={{ margin: 0, fontSize: '1rem', textTransform: 'uppercase', fontWeight: 900 }}>{title}</h3>
    {children}
  </div>
);

/** A label, its control, and at most one short line under it. */
const Field: React.FC<{ label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }> = ({
  label,
  htmlFor,
  hint,
  children,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', flex: 1 }}>
    {htmlFor ? <label htmlFor={htmlFor} style={labelStyle}>{label}</label> : <span style={labelStyle}>{label}</span>}
    {children}
    {hint && <span style={hintStyle}>{hint}</span>}
  </div>
);

/** A key that stays masked until asked for. */
const SecretField: React.FC<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
}> = ({ id, label, value, onChange, hint }) => {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-pressed={shown}
          style={{ padding: 'var(--space-md)', minHeight: '44px', whiteSpace: 'nowrap', fontSize: '0.8rem' }}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
    </Field>
  );
};

/**
 * Start date, posts per day and the hours they spread over. YouTube and Postiz
 * ask the same three questions, so they are asked by the same component in the
 * same words.
 */
const ScheduleFields: React.FC<{
  platform: 'youtube' | 'postiz';
  groupLabel: string;
  startDate: string;
  perDay: number;
  dayStart: number;
  dayEnd: number;
  startHint: string;
  perDayHint?: string;
  onStartDate: (value: string) => void;
  onPerDay: (value: number) => void;
  onDayStart: (value: number) => void;
  onDayEnd: (value: number) => void;
}> = (props) => {
  const { platform } = props;
  return (
    <>
      <Field
        label="Start date"
        htmlFor={`${platform}-start-date`}
        hint={`${props.startHint} At most ${MAX_SCHEDULE_YEARS_AHEAD} years out.`}
      >
        <DateField
          id={`${platform}-start-date`}
          value={props.startDate}
          onCommit={props.onStartDate}
          min={earliestScheduleDate()}
          max={latestScheduleDate()}
          style={inputStyle}
        />
      </Field>

      <Field label="Per day" htmlFor={`${platform}-per-day`} hint={props.perDayHint}>
        <select
          id={`${platform}-per-day`}
          value={String(props.perDay)}
          onChange={(e) => props.onPerDay(Number(e.target.value))}
          style={inputStyle}
        >
          {PER_DAY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </Field>

      {/* Which clock these are on is the one thing that cannot be guessed from
          the numbers, and getting it wrong publishes in the middle of the night. */}
      <Field label="Hours" hint="This machine's clock. The first goes out at the start; the rest are spaced evenly to the end.">
        <div role="group" aria-label={props.groupLabel} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
          <label htmlFor={`${platform}-day-start`} style={{ fontSize: '0.8rem' }}>From</label>
          <select
            id={`${platform}-day-start`}
            value={String(props.dayStart)}
            onChange={(e) => props.onDayStart(Number(e.target.value))}
            style={{ ...inputStyle, width: 'auto' }}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>{hourLabel(hour)}</option>
            ))}
          </select>
          <label htmlFor={`${platform}-day-end`} style={{ fontSize: '0.8rem' }}>to</label>
          <select
            id={`${platform}-day-end`}
            value={String(props.dayEnd)}
            onChange={(e) => props.onDayEnd(Number(e.target.value))}
            style={{ ...inputStyle, width: 'auto' }}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>{hourLabel(hour)}</option>
            ))}
          </select>
        </div>
      </Field>
    </>
  );
};

interface SettingsPageProps {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ theme, setTheme }) => {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('general');
  const { data, isLoading } = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: getSettings as () => Promise<SettingsResponse>,
  });

  // These share their cache entry with the project page, which needs the
  // values ("1920x1080") and not just the names, so the map is what the key
  // holds everywhere.
  const { data: resolutionsData } = useQuery({
    queryKey: ['resolutions'],
    queryFn: getResolutionMap,
  });

  const { data: aspectRatiosData } = useQuery({
    queryKey: ['aspectRatios'],
    queryFn: getAspectRatioMap,
  });

  const { data: captionStyles } = useQuery({
    queryKey: ['captionStyles'],
    queryFn: getCaptionStyles,
  });

  // Only for the placeholder text on the template box: an empty template means
  // the app's own, and the box should show which one that is.
  const { data: descriptionFields } = useQuery({
    queryKey: ['descriptionFields'],
    queryFn: getDescriptionFields,
  });

  // Polled only while a consent is open in the other tab: the answer changes
  // when the user finishes there, which this page has no other way to hear
  // about.
  const { data: youtube } = useQuery({
    queryKey: ['youtubeStatus'],
    queryFn: getYoutubeStatus,
    refetchInterval: (query) => (query.state.data?.consent?.pending ? 2000 : false),
  });

  // Asked once the key is saved, and re-asked when it changes: the channel
  // list is what proves the key works, so it is both the answer and the check.
  const { data: postiz } = useQuery({
    queryKey: ['postizStatus'],
    queryFn: getPostizStatus,
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: connectYoutube,
    onSuccess: ({ authorization_url }) => {
      // A new tab rather than a redirect: leaving this page would lose the
      // settings the user is in the middle of editing.
      window.open(authorization_url, '_blank', 'noopener');
      queryClient.invalidateQueries({ queryKey: ['youtubeStatus'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: cancelYoutubeConnect,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['youtubeStatus'] }),
  });

  const updateMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['pipelineConfig'] });
    },
  });
  // `mutate` is referentially stable across renders; the mutation object is
  // not, so depend on this rather than on `updateMutation`.
  const { mutate: saveSettings } = updateMutation;

  // Held here rather than in the tabs, so switching tab neither loses a key
  // half-typed nor re-hydrates and saves the boxes again.
  const [apiKey, setApiKey] = useState('');
  // Saved when the user leaves the box rather than on every keystroke: these
  // are paragraphs, and each save is a write to disk.
  const [descriptionText, setDescriptionText] = useState('');
  const [descriptionTemplate, setDescriptionTemplate] = useState('');
  const [ytSecrets, setYtSecrets] = useState('');
  const [postizKey, setPostizKey] = useState('');
  const [postizUrl, setPostizUrl] = useState('');
  const [typesafeKey, setTypesafeKey] = useState('');
  const [typesafeUrl, setTypesafeUrl] = useState('');
  // Paragraphs typed once, so they are saved when the user leaves the box —
  // the same way the description template is.
  const [postizText, setPostizText] = useState('');
  const [postizComment, setPostizComment] = useState('');
  const [jsonError, setJsonError] = useState(false);

  const debouncedApiKey = useDebounce(apiKey, 500);
  const debouncedYtSecrets = useDebounce(ytSecrets, 500);
  const debouncedPostizKey = useDebounce(postizKey, 500);
  const debouncedPostizUrl = useDebounce(postizUrl, 500);
  const debouncedTypesafeKey = useDebounce(typesafeKey, 500);
  const debouncedTypesafeUrl = useDebounce(typesafeUrl, 500);

  // Track whether the local state has been initialized from server data
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (data) {
      setApiKey(data.settings?.gemini_api_key || '');
      setYtSecrets(data.settings?.youtube_client_secrets ? JSON.stringify(data.settings.youtube_client_secrets, null, 2) : '');
      setDescriptionText(data.settings?.description_defaults?.text || '');
      setDescriptionTemplate(data.settings?.description_defaults?.template || '');
      setPostizKey(data.settings?.postiz_api_key || '');
      setPostizUrl(data.settings?.postiz_api_url || '');
      setTypesafeKey(data.settings?.typesafe_api_key || '');
      setTypesafeUrl(data.settings?.typesafe_api_url || '');
      setPostizText(data.settings?.postiz_text_template || '');
      setPostizComment(data.settings?.postiz_comment_template || '');
      setInitialized(true);
    }
  }, [data]);

  useEffect(() => {
    // `debouncedApiKey !== apiKey` means the debounce is still catching up with
    // the box - right after hydration it still holds the empty initial value,
    // and saving that would wipe the stored key.
    if (!initialized || !data || debouncedApiKey !== apiKey) return;
    const serverValue = data.settings?.gemini_api_key || '';
    if (debouncedApiKey !== serverValue) {
      saveSettings({ settings: { gemini_api_key: debouncedApiKey } });
    }
  }, [debouncedApiKey, apiKey, data, initialized, saveSettings]);

  useEffect(() => {
    if (!initialized || !data || debouncedYtSecrets !== ytSecrets) return;
    const serverValue = data.settings?.youtube_client_secrets ? JSON.stringify(data.settings.youtube_client_secrets, null, 2) : '';
    if (debouncedYtSecrets !== serverValue) {
      try {
        const parsed = JSON.parse(debouncedYtSecrets);
        saveSettings({ settings: { youtube_client_secrets: parsed } });
        setJsonError(false);
      } catch {
        setJsonError(true);
      }
    }
  }, [debouncedYtSecrets, ytSecrets, data, initialized, saveSettings]);

  // Both Postiz fields are saved the way the Gemini key is, and both
  // invalidate the status: a new key or a new host is a different account, and
  // the channel list has to be re-read against it.
  useEffect(() => {
    if (!initialized || !data || debouncedPostizKey !== postizKey) return;
    if (debouncedPostizKey !== (data.settings?.postiz_api_key || '')) {
      saveSettings({ settings: { postiz_api_key: debouncedPostizKey } });
      queryClient.invalidateQueries({ queryKey: ['postizStatus'] });
    }
  }, [debouncedPostizKey, postizKey, data, initialized, saveSettings, queryClient]);

  useEffect(() => {
    if (!initialized || !data || debouncedPostizUrl !== postizUrl) return;
    if (debouncedPostizUrl !== (data.settings?.postiz_api_url || '')) {
      saveSettings({ settings: { postiz_api_url: debouncedPostizUrl } });
      queryClient.invalidateQueries({ queryKey: ['postizStatus'] });
    }
  }, [debouncedPostizUrl, postizUrl, data, initialized, saveSettings, queryClient]);

  // The Jev key and host are saved the way the Gemini key is.
  useEffect(() => {
    if (!initialized || !data || debouncedTypesafeKey !== typesafeKey) return;
    if (debouncedTypesafeKey !== (data.settings?.typesafe_api_key || '')) {
      saveSettings({ settings: { typesafe_api_key: debouncedTypesafeKey } });
    }
  }, [debouncedTypesafeKey, typesafeKey, data, initialized, saveSettings]);

  useEffect(() => {
    if (!initialized || !data || debouncedTypesafeUrl !== typesafeUrl) return;
    if (debouncedTypesafeUrl !== (data.settings?.typesafe_api_url || '')) {
      saveSettings({ settings: { typesafe_api_url: debouncedTypesafeUrl } });
    }
  }, [debouncedTypesafeUrl, typesafeUrl, data, initialized, saveSettings]);

  if (isLoading) return <div style={{ padding: 'var(--space-md)', fontWeight: 'bold', textTransform: 'uppercase' }}>Loading settings...</div>;

  const settings = data?.settings || { gemini_api_key: '', youtube_client_secrets: null, theme: 'light' as const, video_defaults: { resolution: 'keep original', aspect_ratio: 'keep original' } };
  const pipelineConfig = data?.pipeline_config || { execution_order: [], steps: {} };

  // Both of these arrive by being promoted from a project rather than by being
  // typed here, so this page reports them rather than offering the whole form
  // twice: a caption adjustment and a title look are judged against real clips.
  const captionOverrideCount = Object.keys(data?.settings?.caption_defaults?.overrides ?? {}).length;
  const overlayDefaults = data?.settings?.overlay_defaults || null;

  // Which channels an import files against, and how it is changed. Saved on the
  // click rather than behind a Save button: it is one boolean per channel, and
  // every other control on this page saves itself too.
  //
  // Nothing is ticked until the user ticks it. An empty list means no import
  // happens — not "all of them", which is what it used to mean and which sent
  // a project's clips to every account connected to Postiz.
  const selectedChannels: string[] = settings.postiz_channels || [];
  const channelSettings = settings.postiz_channel_settings || {};
  const toggleChannel = (id: string) => {
    const next = selectedChannels.includes(id)
      ? selectedChannels.filter((entry) => entry !== id)
      : [...selectedChannels, id];
    saveSettings({ settings: { postiz_channels: next } });
  };

  const getSaveStatus = () => {
    if (updateMutation.isError) return { text: 'ERROR SAVING!', color: 'var(--error)' };
    if (updateMutation.isPending) return { text: 'SAVING...', color: 'var(--text)' };
    if (updateMutation.isSuccess) return { text: 'SAVED!', color: 'green' };
    return { text: 'All changes saved', color: 'var(--text)', opacity: 0.6 };
  };

  const status = getSaveStatus();

  // What every highlights run asks for unless a project says otherwise. Stored
  // as one key, so each field writes the whole object back with its own value
  // changed rather than replacing the others with nothing.
  const highlightDefaults = settings.highlight_defaults ?? {};

  /**
   * One number of the highlights range, saved when the field is left.
   *
   * Empty means "whatever the app ships with" and is stored by dropping the
   * key, not by writing zero: a run told to return between zero and zero clips
   * is not a setting anybody meant to type. A value out of range is ignored,
   * because the backend would ignore it too and the field would then show a
   * number nothing is using.
   */
  const highlightNumberField = (field: HighlightNumberField, label: string, max: number, unit: string) => {
    const stored = highlightDefaults[field];
    const commit = (raw: string) => {
      const text = raw.trim();
      const next = { ...highlightDefaults };
      if (text === '') {
        if (stored === undefined) return;
        delete next[field];
      } else {
        const value = Number(text);
        if (!Number.isFinite(value) || value < 1 || value > max) return;
        if (stored === value) return;
        next[field] = value;
      }
      saveSettings({ settings: { highlight_defaults: next } });
    };
    return (
      <Field label={label} htmlFor={`highlight-${field}`} hint={`Empty is ${SHIPPED_HIGHLIGHT_DEFAULTS[field]}${unit}.`}>
        <input
          id={`highlight-${field}`}
          type="number"
          min={1}
          max={max}
          // Keyed by the stored value, so clearing the field and leaving it
          // shows the shipped default again rather than the text just deleted.
          key={`highlight-${field}-${String(stored)}`}
          defaultValue={stored === undefined ? '' : String(stored)}
          placeholder={String(SHIPPED_HIGHLIGHT_DEFAULTS[field])}
          onBlur={(e) => commit(e.target.value)}
          style={inputStyle}
        />
      </Field>
    );
  };

  const usingJev = settings.highlight_provider === 'jev';

  const general = (
    <Card title="Appearance and language">
      <Field label="Theme">
        <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
          {(['light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTheme(t);
                updateMutation.mutate({ settings: { theme: t } });
              }}
              aria-pressed={theme === t}
              style={{
                padding: 'var(--space-md) var(--space-lg)',
                background: theme === t ? 'var(--text)' : 'var(--bg)',
                color: theme === t ? 'var(--bg)' : 'var(--text)',
                border: 'var(--border)',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Spoken language" htmlFor="transcription-language" hint="The language your videos are in. Change it before transcribing.">
        <select
          id="transcription-language"
          value={settings.transcription_language || 'en'}
          onChange={(e) => saveSettings({ settings: { transcription_language: e.target.value } })}
          style={inputStyle}
        >
          {TRANSCRIPTION_LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
      </Field>
    </Card>
  );

  const secrets = (
    <>
      <Card title="Gemini">
        <SecretField id="gemini-api-key" label="Gemini API Key" value={apiKey} onChange={setApiKey} />
      </Card>

      <Card title="Jev (TypeSafe)">
        <SecretField
          id="typesafe-api-key"
          label="Jev (TypeSafe) API Key"
          value={typesafeKey}
          onChange={setTypesafeKey}
          hint="In the TypeSafe console under API Keys."
        />
        <Field label="URL" htmlFor="typesafe-api-url" hint="Empty for TypeSafe cloud. Set only to go through a gateway.">
          <input
            id="typesafe-api-url"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.typesafe.ai"
            value={typesafeUrl}
            onChange={(e) => setTypesafeUrl(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </Card>

      <Card title="YouTube">
        <Field label="Client secrets (JSON)" htmlFor="youtube-client-secrets">
          <textarea
            id="youtube-client-secrets"
            value={ytSecrets}
            onChange={(e) => setYtSecrets(e.target.value)}
            style={{ ...inputStyle, minHeight: '150px', fontFamily: 'monospace' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <input
              type="file"
              id="file-input"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (event) => {
                    try {
                      const parsed = JSON.parse(event.target?.result as string);
                      setYtSecrets(JSON.stringify(parsed, null, 2));
                      updateMutation.mutate({ settings: { youtube_client_secrets: parsed } });
                      setJsonError(false);
                    } catch {
                      setJsonError(true);
                    }
                  };
                  reader.readAsText(file);
                }
              }}
            />
            <label
              htmlFor="file-input"
              style={{
                padding: 'var(--space-xs) var(--space-sm)',
                border: 'var(--border)',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                cursor: 'pointer',
                background: 'var(--bg)',
                fontSize: '0.8rem',
              }}
            >
              Choose JSON File
            </label>
            <span style={hintStyle}>
              {settings.youtube_client_secrets ? 'Loaded' : 'No file loaded'}
            </span>
          </div>
          {jsonError && <span style={errorStyle}>Invalid JSON.</span>}
        </Field>
      </Card>

      <Card title="Postiz">
        <SecretField
          id="postiz-api-key"
          label="Postiz API Key"
          value={postizKey}
          onChange={setPostizKey}
          hint="In Postiz under Settings, Public API."
        />
        {/* The address of the instance, not of its API: which path the API
            lives under depends on whether it is self-hosted, and that is not
            something anyone should have to know. */}
        <Field
          label="URL"
          htmlFor="postiz-api-url"
          hint={`Your instance as you open it in a browser. Empty for Postiz cloud.${postiz?.api_url ? ` Calling ${postiz.api_url}.` : ''}`}
        >
          <input
            id="postiz-api-url"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://postiz.example.com"
            value={postizUrl}
            onChange={(e) => setPostizUrl(e.target.value)}
            style={inputStyle}
          />
        </Field>
      </Card>
    </>
  );

  const video = (
    <>
      <Card title="Output">
        <Field label="Resolution" htmlFor="video-resolution">
          <select
            id="video-resolution"
            value={settings.video_defaults?.resolution || 'keep original'}
            onChange={(e) => updateMutation.mutate({ settings: { video_defaults: { ...settings.video_defaults, resolution: e.target.value } } })}
            style={inputStyle}
          >
            <option value="keep original">keep original</option>
            {Object.keys(resolutionsData ?? {}).map((opt) => <option key={opt} value={opt}>{opt.toUpperCase()}</option>)}
          </select>
        </Field>
        <Field label="Aspect ratio" htmlFor="video-aspect-ratio">
          <select
            id="video-aspect-ratio"
            value={settings.video_defaults?.aspect_ratio || 'keep original'}
            onChange={(e) => updateMutation.mutate({ settings: { video_defaults: { ...settings.video_defaults, aspect_ratio: e.target.value } } })}
            style={inputStyle}
          >
            <option value="keep original">keep original</option>
            {Object.keys(aspectRatiosData ?? {}).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </Field>
        <Field label="Encoder codec" htmlFor="video-codec" hint="e.g. libx264, or h264_videotoolbox on a Mac.">
          <input
            id="video-codec"
            type="text"
            value={settings.codec || 'libx264'}
            onChange={(e) => updateMutation.mutate({ settings: { codec: e.target.value } })}
            style={inputStyle}
          />
        </Field>
      </Card>

      {/* Only the starting point for new projects. Each project keeps its own
          caption settings from then on, styled on its clip pages. */}
      <Card title="Captions">
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: 'pointer', ...labelStyle }}>
          <input
            type="checkbox"
            checked={Boolean(settings.caption_defaults?.enabled)}
            onChange={(e) => updateMutation.mutate({
              settings: { caption_defaults: { ...settings.caption_defaults, enabled: e.target.checked } },
            })}
            style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
          />
          Burn captions into new projects
        </label>
        <Field label="Style" htmlFor="caption-preset">
          <select
            id="caption-preset"
            value={settings.caption_defaults?.preset || 'karaoke_pop'}
            onChange={(e) => updateMutation.mutate({
              settings: { caption_defaults: { ...settings.caption_defaults, preset: e.target.value } },
            })}
            style={inputStyle}
          >
            {Object.entries(captionStyles ?? {}).map(([name, preset]) => (
              <option key={name} value={name}>{preset.label}</option>
            ))}
          </select>
        </Field>
        {captionOverrideCount > 0 && (
          <span style={hintStyle}>
            {captionOverrideCount} adjustment{captionOverrideCount === 1 ? '' : 's'} saved from a project.{' '}
            <button
              type="button"
              className="text-action"
              onClick={() => saveSettings({
                settings: { caption_defaults: { ...settings.caption_defaults, overrides: {} } },
              })}
            >
              Reset to plain style
            </button>
          </span>
        )}
      </Card>

      {/* Set from a project rather than here: a title look is judged against
          real clips, and a project's Overlay titles dialog is where it is
          settled and promoted from. */}
      <Card title="Overlay titles">
        <span style={{ fontSize: '0.9rem' }}>
          {overlayDefaults
            ? `${overlayDefaults.enabled ? 'On' : 'Off'} · ${overlayDefaults.font_family ?? 'default font'} · ${overlayDefaults.font_size_pct ?? '—'}% of frame · ${overlayDefaults.position_pct ?? '—'}% from top`
            : 'Off for new projects.'}
        </span>
        <span style={hintStyle}>
          Set from a project: open <strong>Overlay titles</strong>, style it, then save it as the default.
          {overlayDefaults && (
            <>
              {' '}
              <button
                type="button"
                className="text-action"
                onClick={() => saveSettings({ settings: { overlay_defaults: null } })}
              >
                Clear
              </button>
            </>
          )}
        </span>
      </Card>
    </>
  );

  // Read when the step runs rather than copied into a project at creation, so a
  // change here moves every project that has not answered for itself — on its
  // next run, never on highlights already found.
  const highlights = (
    <>
      <p style={{ margin: 0, ...hintStyle }}>Used by every project that hasn't set its own.</p>

      <Card title="Finder">
        <Field label="Provider" htmlFor="highlight-provider" hint="Jev picks the clips; Gemini still writes their titles, so Jev needs both keys.">
          <select
            id="highlight-provider"
            value={settings.highlight_provider || 'gemini'}
            onChange={(e) => saveSettings({ settings: { highlight_provider: e.target.value as 'gemini' | 'jev' } })}
            style={inputStyle}
          >
            <option value="gemini">Gemini</option>
            <option value="jev">Jev (TypeSafe)</option>
          </select>
        </Field>
        {/* Shown whatever the provider, so picking one does not move the page
            under the pointer; it just has nothing to do under Gemini. */}
        <Field
          label="Minimum clip score"
          htmlFor="jev-min-score"
          hint={usingJev ? '0–100, relative to each video. Lower-scoring clips go under “show more”.' : 'Jev only.'}
        >
          <input
            id="jev-min-score"
            type="number"
            min={0}
            max={100}
            step={1}
            disabled={!usingJev}
            key={`jev-min-score-${settings.jev_min_score ?? 0}`}
            defaultValue={Math.round((settings.jev_min_score ?? 0) * 100)}
            onBlur={(e) => {
              const next = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))) / 100;
              if (next !== (settings.jev_min_score ?? 0)) saveSettings({ settings: { jev_min_score: next } });
            }}
            style={inputStyle}
          />
        </Field>
      </Card>

      <Card title="Limits">
        <span style={hintStyle}>Hard limits: the model's answer is rejected outside them.</span>
        <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          {highlightNumberField('min_clips', 'Fewest clips', MAX_HIGHLIGHT_CLIPS, '')}
          {highlightNumberField('max_clips', 'Most clips', MAX_HIGHLIGHT_CLIPS, '')}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          {highlightNumberField('min_duration', 'Shortest clip (s)', MAX_HIGHLIGHT_DURATION, 's')}
          {highlightNumberField('max_duration', 'Longest clip (s)', MAX_HIGHLIGHT_DURATION, 's')}
        </div>
      </Card>

      <Card title="Guidance">
        <Field
          label="What counts as a highlight"
          htmlFor="highlight-guidance"
          hint="Added to the prompt. Outranks its preferences, not its rules."
        >
          <textarea
            id="highlight-guidance"
            // Written when the field is left rather than per keystroke: this is
            // a sentence typed once, not a control being dragged.
            key={`highlight-guidance-${highlightDefaults.guidance ?? ''}`}
            defaultValue={highlightDefaults.guidance ?? ''}
            onBlur={(e) => {
              const next = e.target.value;
              if (next === (highlightDefaults.guidance ?? '')) return;
              saveSettings({
                settings: { highlight_defaults: { ...highlightDefaults, guidance: next } },
              });
            }}
            placeholder="e.g. prefer strong opinions over stories, and never open on a question"
            style={{ ...inputStyle, minHeight: '110px', lineHeight: 1.4 }}
          />
        </Field>
      </Card>
    </>
  );

  const youtubeTab = (
    <>
      {/* The client secrets say which Google project may ask; this is the
          one-time consent that lets it publish. */}
      <Card title="Channel">
        {/* A channel that was connected and has since been refused reads as an
            error, not as a neutral "not connected": nothing on this page
            changed, the uploads simply stopped working. */}
        <span
          style={
            youtube && !youtube.connected && youtube.expired
              ? errorStyle
              : { fontSize: '0.9rem' }
          }
        >
          {youtube?.connected
            ? `Connected${youtube.account ? ` as ${youtube.account}` : ''}`
            : (youtube?.reason || 'No channel connected.')}
        </span>

        {/* Not an error: uploads work without either. Readonly is how a clip
            notices its video was deleted on YouTube; force-ssl is how
            regenerating on Upload takes the old video down. */}
        {youtube?.connected && (youtube.missing_scopes?.length ?? 0) > 0 && (
          <span style={errorStyle}>
            Missing permission: {youtube.missing_scopes?.join(', ')}.{' '}
            {youtube.missing_scopes?.some((scope) => scope.endsWith('youtube.readonly')) &&
              'A clip whose video has been deleted on YouTube cannot be noticed, so its page keeps a dead link. '}
            {youtube.missing_scopes?.some((scope) => scope.endsWith('youtube.force-ssl')) &&
              'Regenerating on Upload cannot replace a clip’s old video. '}
            Reconnect to grant it.
          </span>
        )}

        {youtube?.consent?.pending && (
          <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>
            Waiting for you to finish in the tab that opened. Closed it, or picked the
            wrong account? Press the button for a new one.
          </span>
        )}
        {youtube?.consent?.error && (
          <span style={{ fontSize: '0.8rem', color: 'var(--error)' }}>{youtube.consent.error}</span>
        )}
        {connectMutation.isError && (
          <span style={{ fontSize: '0.8rem', color: 'var(--error)' }}>
            {(connectMutation.error as Error).message}
          </span>
        )}

        {/* Never disabled by an attempt already waiting: a consent nobody
            finished is exactly when this gets pressed, and the backend gives
            the new one its own window rather than refusing it. */}
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <button
            type="button"
            onClick={() => connectMutation.mutate()}
            disabled={!settings.youtube_client_secrets || connectMutation.isPending}
            style={buttonStyle}
          >
            {youtube?.consent?.pending
              ? 'Open Sign-in Again'
              : youtube?.connected ? 'Reconnect Channel' : 'Connect Channel'}
          </button>
          {youtube?.consent?.pending && (
            <button
              type="button"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              style={buttonStyle}
            >
              Cancel
            </button>
          )}
        </div>
        {!settings.youtube_client_secrets && (
          <span style={hintStyle}>
            Add the YouTube client secrets under{' '}
            <button type="button" className="text-action" onClick={() => setTab('secrets')}>Secrets</button>{' '}
            first.
          </span>
        )}
      </Card>

      {/* Publishing is the one thing this app does that it cannot undo, so the
          choice is here rather than on the button that does it — and a project
          may still disagree with it. */}
      <Card title="Publishing">
        <Field
          label="Privacy"
          htmlFor="youtube-privacy"
          hint="Scheduled uploads go up private; YouTube makes them public at their time."
        >
          <select
            id="youtube-privacy"
            value={settings.youtube_privacy || 'private'}
            onChange={(e) => saveSettings({ settings: { youtube_privacy: e.target.value as UploadPrivacy } })}
            style={inputStyle}
          >
            {(Object.keys(PRIVACY_LABELS) as UploadPrivacy[]).map((value) => (
              <option key={value} value={value}>{PRIVACY_LABELS[value]}</option>
            ))}
          </select>
        </Field>
      </Card>

      {/* The card stays when the privacy is not a schedule, so the page does
          not jump; the fields inside it are kept in storage either way, so a
          week on private does not cost the user the calendar they typed. */}
      <Card title="Schedule">
        {settings.youtube_privacy === 'schedule' ? (
          <ScheduleFields
            platform="youtube"
            groupLabel="Hours YouTube clips go public between"
            startDate={settings.youtube_schedule_start_date || ''}
            perDay={settings.youtube_schedule_per_day ?? 0}
            dayStart={settings.youtube_schedule_day_start_hour ?? 9}
            dayEnd={settings.youtube_schedule_day_end_hour ?? 21}
            startHint="Empty publishes as soon as the upload is done."
            onStartDate={(value) => saveSettings({ settings: { youtube_schedule_start_date: value } })}
            onPerDay={(value) => saveSettings({ settings: { youtube_schedule_per_day: value } })}
            onDayStart={(value) => saveSettings({ settings: { youtube_schedule_day_start_hour: value } })}
            onDayEnd={(value) => saveSettings({ settings: { youtube_schedule_day_end_hour: value } })}
          />
        ) : (
          <span style={hintStyle}>Set Privacy to scheduled to publish on a calendar.</span>
        )}
      </Card>

      {/* Unlike the caption defaults, these are read when a clip is uploaded
          rather than copied into a project, so editing them changes what every
          existing project publishes. */}
      <Card title="Description">
        <span style={hintStyle}>The source link and per-project text are set on each project's page.</span>
        <Field label="Shared text" htmlFor="description-global-text" hint={<>Placed where the template says {'{global.text}'}.</>}>
          <textarea
            id="description-global-text"
            value={descriptionText}
            onChange={(e) => setDescriptionText(e.target.value)}
            onBlur={() => {
              if (descriptionText === (settings.description_defaults?.text || '')) return;
              saveSettings({
                settings: { description_defaults: { ...settings.description_defaults, text: descriptionText } },
              });
            }}
            placeholder="Subscribe for more, links, credits…"
            style={{ ...inputStyle, minHeight: '90px' }}
          />
        </Field>
        <Field label="Template" htmlFor="description-template" hint="Empty uses the template shown. Fields in braces are replaced.">
          <textarea
            id="description-template"
            value={descriptionTemplate}
            onChange={(e) => setDescriptionTemplate(e.target.value)}
            onBlur={() => {
              if (descriptionTemplate === (settings.description_defaults?.template || '')) return;
              saveSettings({
                settings: { description_defaults: { ...settings.description_defaults, template: descriptionTemplate } },
              });
            }}
            placeholder={descriptionFields?.default_template}
            style={{ ...inputStyle, minHeight: '180px', fontFamily: 'monospace' }}
          />
        </Field>
        <DescriptionFieldHelp />
      </Card>
    </>
  );

  // Postiz: everywhere that is not YouTube. Clips are handed to the scheduler
  // the user already runs rather than published from here, so this tab
  // configures a destination, not a second publisher.
  const postizTab = (
    <>
      <p style={{ margin: 0, ...hintStyle }}>
        Importing a clip sends it to Postiz with a post written for each channel.
      </p>

      {/* Read from Postiz rather than typed, because the ids a post is
          addressed by are not something anyone knows by heart. */}
      <Card title="Channels">
        {!postiz?.configured && (
          <span style={hintStyle}>
            Add a Postiz API key under{' '}
            <button type="button" className="text-action" onClick={() => setTab('secrets')}>Secrets</button>{' '}
            to see the connected channels.
          </span>
        )}
        {postiz?.configured && postiz.error && (
          <span role="alert" style={{ ...errorStyle, overflowWrap: 'anywhere' }}>{postiz.error}</span>
        )}
        {postiz?.channels?.length === 0 && (
          <span style={hintStyle}>This Postiz account has no channels connected yet.</span>
        )}
        {(postiz?.channels || []).map((channel) => (
          <label
            key={channel.id}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: '0.9rem', minHeight: '44px' }}
          >
            <input
              type="checkbox"
              checked={selectedChannels.includes(channel.id)}
              onChange={() => toggleChannel(channel.id)}
            />
            <span>
              {channel.name || channel.id}
              {channel.identifier ? ` (${channel.identifier})` : ''}
              {channel.disabled ? ' — disabled in Postiz' : ''}
            </span>
          </label>
        ))}
        {(postiz?.channels?.length ?? 0) > 0 && selectedChannels.length === 0 && (
          <span style={hintStyle}>Nothing ticked, so nothing is imported.</span>
        )}
        {/* Some platforms need something only you can supply — a Discord
            channel id, a subreddit. Postiz refuses the post without it and says
            which field it wanted, and that message appears on the clip. Free-form
            on purpose: which field each platform wants is Postiz's business. */}
        {selectedChannels.length > 0 && (
          <details style={{ fontSize: '0.8rem' }}>
            <summary style={{ cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' }}>
              Extra settings for a channel
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
              {(postiz?.channels || [])
                .filter((channel) => selectedChannels.includes(channel.id))
                .map((channel) => (
                  <Field
                    key={channel.id}
                    htmlFor={`postiz-extra-${channel.id}`}
                    label={`${channel.name || channel.id}${channel.identifier ? ` (${channel.identifier})` : ''}`}
                  >
                    <input
                      id={`postiz-extra-${channel.id}`}
                      type="text"
                      placeholder="field=value, e.g. channel=123456789012345678"
                      defaultValue={Object.entries(channelSettings[channel.id] || {})
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', ')}
                      onBlur={(e) => {
                        // Saved on leaving the box rather than per keystroke:
                        // half a field name is not a setting.
                        const entries = e.target.value
                          .split(',')
                          .map((pair) => pair.split('='))
                          .filter((pair) => pair.length === 2 && pair[0].trim());
                        saveSettings({
                          settings: {
                            postiz_channel_settings: {
                              ...channelSettings,
                              [channel.id]: Object.fromEntries(
                                entries.map(([key, value]) => [key.trim(), value.trim()])
                              ),
                            },
                          },
                        });
                      }}
                      style={inputStyle}
                    />
                  </Field>
                ))}
            </div>
          </details>
        )}
      </Card>

      <Card title="Publishing">
        <Field label="Post type" htmlFor="postiz-post-type">
          <select
            id="postiz-post-type"
            value={settings.postiz_post_type || 'draft'}
            onChange={(e) => saveSettings({ settings: { postiz_post_type: e.target.value as 'draft' | 'schedule' | 'now' } })}
            style={inputStyle}
          >
            {/* Draft first and by default: it is the only one of the three that
                cannot reach an audience by accident. */}
            <option value="draft">Draft, for you to send</option>
            <option value="schedule">Scheduled</option>
            <option value="now">Posted immediately</option>
          </select>
        </Field>
      </Card>

      {/* Asked whatever an import makes, because a draft has a date too — it
          is where it sits on the calendar. */}
      <Card title="Schedule">
        <ScheduleFields
          platform="postiz"
          groupLabel="Hours Postiz posts land between"
          startDate={settings.postiz_schedule_start_date || ''}
          perDay={settings.postiz_per_day ?? 0}
          dayStart={settings.postiz_day_start_hour ?? 9}
          dayEnd={settings.postiz_day_end_hour ?? 21}
          startHint="Empty starts an hour after the import."
          perDayHint="A re-imported clip keeps its slot."
          onStartDate={(value) => saveSettings({ settings: { postiz_schedule_start_date: value } })}
          onPerDay={(value) => saveSettings({ settings: { postiz_per_day: value } })}
          onDayStart={(value) => saveSettings({ settings: { postiz_day_start_hour: value } })}
          onDayEnd={(value) => saveSettings({ settings: { postiz_day_end_hour: value } })}
        />
      </Card>

      <Card title="Post text">
        <Field label="Post" htmlFor="postiz-text" hint="Empty uses what the model wrote for each platform.">
          <textarea
            id="postiz-text"
            value={postizText}
            onChange={(e) => setPostizText(e.target.value)}
            onBlur={() => {
              if (postizText !== (data?.settings?.postiz_text_template || '')) {
                saveSettings({ settings: { postiz_text_template: postizText } });
              }
            }}
            placeholder={'{platform.post}\n\nFrom {project.source_title}'}
            style={{ ...inputStyle, minHeight: '110px', fontFamily: 'monospace' }}
          />
        </Field>
        {/* Why anyone wants this, said once: it is not obvious that the link is
            better off out of the post itself. */}
        <Field
          label="First comment"
          htmlFor="postiz-comment"
          hint="Keeps links out of the post, which most platforms show less. Skipped when empty."
        >
          <textarea
            id="postiz-comment"
            value={postizComment}
            onChange={(e) => setPostizComment(e.target.value)}
            onBlur={() => {
              if (postizComment !== (data?.settings?.postiz_comment_template || '')) {
                saveSettings({ settings: { postiz_comment_template: postizComment } });
              }
            }}
            placeholder={'Full episode: {project.source_url}'}
            style={{ ...inputStyle, minHeight: '70px', fontFamily: 'monospace' }}
          />
        </Field>
        <DescriptionFieldHelp extra={POSTIZ_FIELDS} />
      </Card>
    </>
  );

  const pipeline = (
    <Card title="Steps">
      <span style={hintStyle}>The order steps run in, and which ones run by themselves.</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {pipelineConfig.execution_order?.map((step: string, index: number) => (
          <div key={step} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-md)',
            padding: 'var(--space-sm) 0',
            borderBottom: 'var(--border)',
          }}>
            <span style={{ width: '24px', fontWeight: 'bold', fontSize: '1rem', opacity: 0.6 }}>{index + 1}.</span>
            <span style={{ flex: 1, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>{step}</span>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '0.8rem',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={pipelineConfig.steps?.[step]?.auto_run || false}
                onChange={(e) => {
                  const newConfig = JSON.parse(JSON.stringify(pipelineConfig));
                  newConfig.steps[step].auto_run = e.target.checked;
                  updateMutation.mutate({
                    settings: data?.settings || {},
                    pipeline_config: newConfig,
                  });
                }}
                style={{ cursor: 'pointer' }}
              />
              Auto-run
            </label>
          </div>
        ))}
      </div>
    </Card>
  );

  const panels: Record<Tab, React.ReactNode> = {
    general,
    secrets,
    video,
    highlights,
    youtube: youtubeTab,
    postiz: postizTab,
    pipeline,
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-lg)',
      width: '100%',
      maxWidth: '800px',
      margin: '0 auto',
      padding: 'var(--space-md)'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        borderBottom: 'var(--border)',
        paddingBottom: 'var(--space-sm)'
      }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 900,
          textTransform: 'uppercase',
          margin: 0,
        }}>Settings</h1>
        <span style={{
          fontSize: '0.8rem',
          fontWeight: 'bold',
          textTransform: 'uppercase',
          color: status.color,
          opacity: status.opacity || 1,
        }}>
          {status.text}
        </span>
      </div>

      {updateMutation.isError && (
        <div style={{
          border: '1px solid var(--error)',
          padding: 'var(--space-sm)',
          color: 'var(--error)',
          fontWeight: 'bold',
          textTransform: 'uppercase',
        }}>
          Failed to save settings. Please check your connection.
        </div>
      )}

      {/* Scrolls sideways on a narrow screen rather than wrapping, so the tabs
          stay one row. */}
      <div role="tablist" aria-label="Settings" style={{ display: 'flex', gap: 'var(--space-xs)', overflowX: 'auto' }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="settings-panel"
            onClick={() => setTab(id)}
            style={{
              padding: 'var(--space-sm) var(--space-md)',
              minHeight: '44px',
              background: tab === id ? 'var(--text)' : 'var(--bg)',
              color: tab === id ? 'var(--bg)' : 'var(--text)',
              border: 'var(--border)',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              fontSize: '0.8rem',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${tab}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}
      >
        {panels[tab]}
      </div>
    </div>
  );
};
