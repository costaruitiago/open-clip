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

interface SettingsPageProps {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ theme, setTheme }) => {
  const queryClient = useQueryClient();
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

  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  // Saved when the user leaves the box rather than on every keystroke: these
  // are paragraphs, and each save is a write to disk.
  const [descriptionText, setDescriptionText] = useState('');
  const [descriptionTemplate, setDescriptionTemplate] = useState('');
  const [ytSecrets, setYtSecrets] = useState('');
  const [postizKey, setPostizKey] = useState('');
  const [showPostizKey, setShowPostizKey] = useState(false);
  const [postizUrl, setPostizUrl] = useState('');
  // Paragraphs typed once, so they are saved when the user leaves the box —
  // the same way the description template is.
  const [postizText, setPostizText] = useState('');
  const [postizComment, setPostizComment] = useState('');
  const [jsonError, setJsonError] = useState(false);

  const debouncedApiKey = useDebounce(apiKey, 500);
  const debouncedYtSecrets = useDebounce(ytSecrets, 500);
  const debouncedPostizKey = useDebounce(postizKey, 500);
  const debouncedPostizUrl = useDebounce(postizUrl, 500);

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
  // the channel list below has to be re-read against it.
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

  const inputStyle: React.CSSProperties = {
    padding: 'var(--space-md)',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: 'var(--border)',
    fontFamily: 'inherit',
    width: '100%',
  };

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
  const highlightNumberField = (
    field: HighlightNumberField,
    label: string,
    max: number,
    unit: string
  ) => {
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', flex: 1 }}>
        <label htmlFor={`highlight-${field}`} style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>
          {label}:
        </label>
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
        <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
          Empty is {SHIPPED_HIGHLIGHT_DEFAULTS[field]}{unit}, what the prompt ships with.
        </span>
      </div>
    );
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

      {/* Appearance Section */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>Appearance</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
          <span style={{ fontWeight: 'bold', textTransform: 'uppercase' }}>Theme:</span>
          <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
            {(['light', 'dark'] as const).map((t) => (
              <button 
                key={t}
                onClick={() => {
                  setTheme(t);
                  updateMutation.mutate({ settings: { theme: t } });
                }}
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
        </div>
      </section>

      {/* API Keys Section */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>API Keys</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="gemini-api-key" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Gemini API Key:</label>
          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <input
              id="gemini-api-key"
              type={showApiKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((v) => !v)}
              aria-pressed={showApiKey}
              style={{
                padding: 'var(--space-md)',
                minHeight: '44px',
                whiteSpace: 'nowrap',
                fontSize: '0.8rem',
              }}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>YouTube Client Secrets (JSON):</label>
          <textarea
            value={ytSecrets}
            onChange={(e) => setYtSecrets(e.target.value)}
            style={{ ...inputStyle, minHeight: '150px', fontFamily: 'monospace' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginTop: 'var(--space-xs)' }}>
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
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              {settings.youtube_client_secrets ? 'Config loaded successfully' : 'No file selected'}
            </span>
          </div>
          {jsonError && (
            <span style={{ color: 'var(--error)', fontSize: '0.8rem', fontWeight: 'bold', textTransform: 'uppercase', marginTop: 'var(--space-xs)' }}>
              Invalid JSON file content.
            </span>
          )}
        </div>

        {/* The channel itself. The secrets above say which Google project may
            ask; this is the one-time consent that lets it publish. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', border: 'var(--border)', padding: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>YouTube Channel:</label>
          {/* A channel that was connected and has since been refused reads as an
              error, not as a neutral "not connected": nothing on this page
              changed, the uploads simply stopped working, and the sentence
              saying so has to look like the problem it is. */}
          <span
            style={
              youtube && !youtube.connected && youtube.expired
                ? { fontSize: '0.8rem', color: 'var(--error)', fontWeight: 'bold' }
                : { fontSize: '0.8rem', opacity: 0.8 }
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
            <span style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 'bold' }}>
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
            <span style={{ fontSize: '0.8rem', color: 'var(--error)' }}>
              {youtube.consent.error}
            </span>
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
              style={{
                padding: 'var(--space-xs) var(--space-sm)',
                minHeight: '44px',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                fontSize: '0.8rem',
                alignSelf: 'flex-start',
              }}
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
                style={{
                  padding: 'var(--space-xs) var(--space-sm)',
                  minHeight: '44px',
                  fontWeight: 'bold',
                  textTransform: 'uppercase',
                  fontSize: '0.8rem',
                  alignSelf: 'flex-start',
                }}
              >
                Cancel
              </button>
            )}
          </div>
          {!settings.youtube_client_secrets && (
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              Add the client secrets above first.
            </span>
          )}
        </div>

        {/* What an upload makes. Publishing is the one thing this app does that
            it cannot undo, so the choice is here rather than on the button that
            does it — and a project may still disagree with it. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="youtube-privacy" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>What an upload makes:</label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            {/* Said plainly because it is not obvious that the fourth choice is
                the first one wearing a hat. */}
            A scheduled clip goes up private with a publish time on it; YouTube turns it public
            itself when the time comes.
          </span>
        </div>

        {/* Only under a schedule: these say nothing about a clip that is public
            the moment it lands. They are kept when the privacy changes, so a
            week on private does not cost the user the calendar they typed. */}
        {settings.youtube_privacy === 'schedule' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', border: 'var(--border)', padding: 'var(--space-sm)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              <label htmlFor="youtube-start-date" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>First clip goes public on:</label>
              <DateField
                id="youtube-start-date"
                value={settings.youtube_schedule_start_date || ''}
                onCommit={(value) =>
                  saveSettings({ settings: { youtube_schedule_start_date: value } })
                }
                min={earliestScheduleDate()}
                max={latestScheduleDate()}
                style={inputStyle}
              />
              <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
                Empty publishes as soon as the upload is done. Today at the earliest — YouTube
                refuses a publish time behind it — and at most {MAX_SCHEDULE_YEARS_AHEAD} years out.
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              <label htmlFor="youtube-per-day" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>How many go public per day:</label>
              <select
                id="youtube-per-day"
                value={String(settings.youtube_schedule_per_day ?? 0)}
                onChange={(e) =>
                  saveSettings({ settings: { youtube_schedule_per_day: Number(e.target.value) } })
                }
                style={inputStyle}
              >
                {PER_DAY_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              <span style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Spread between:</span>
              {/* Grouped and named. "From" and "to" say which end of the window
                  a select is, and nothing about which schedule it belongs to —
                  and this page now carries two of these, one per platform. */}
              <div
                role="group"
                aria-label="Hours YouTube clips go public between"
                style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}
              >
                <label htmlFor="youtube-day-start" style={{ fontSize: '0.8rem' }}>From</label>
                <select
                  id="youtube-day-start"
                  value={String(settings.youtube_schedule_day_start_hour ?? 9)}
                  onChange={(e) =>
                    saveSettings({ settings: { youtube_schedule_day_start_hour: Number(e.target.value) } })
                  }
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>{hourLabel(hour)}</option>
                  ))}
                </select>
                <label htmlFor="youtube-day-end" style={{ fontSize: '0.8rem' }}>to</label>
                <select
                  id="youtube-day-end"
                  value={String(settings.youtube_schedule_day_end_hour ?? 21)}
                  onChange={(e) =>
                    saveSettings({ settings: { youtube_schedule_day_end_hour: Number(e.target.value) } })
                  }
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>{hourLabel(hour)}</option>
                  ))}
                </select>
              </div>
              <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
                {/* Which clock these are on is the one thing that cannot be
                    guessed from the numbers, and getting it wrong publishes a
                    short in the middle of somebody's night. */}
                On this machine's clock. One clip a day goes out at the first hour; the rest of a
                day's clips are spaced evenly up to the last.
              </span>
            </div>
          </div>
        )}
      </section>

      {/* Postiz: everywhere that is not YouTube. Clips are handed to the
          scheduler the user already runs rather than published from here, so
          this section configures a destination, not a second publisher. */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>Postiz</h2>
        <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.8 }}>
          Importing a clip cuts it afresh, sends the video to Postiz and writes the post
          for each channel. Nothing is published: what arrives is a draft you open and send.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-api-key" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Postiz API Key:</label>
          <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
            <input
              id="postiz-api-key"
              type={showPostizKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={postizKey}
              onChange={(e) => setPostizKey(e.target.value)}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => setShowPostizKey((v) => !v)}
              aria-pressed={showPostizKey}
              style={{
                padding: 'var(--space-md)',
                minHeight: '44px',
                whiteSpace: 'nowrap',
                fontSize: '0.8rem',
              }}
            >
              {showPostizKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            In Postiz under Settings, Public API.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-api-url" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Postiz URL:</label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            {/* The address of the instance, not of its API: which path the API
                lives under depends on whether it is self-hosted, and that is
                not something anyone should have to know. */}
            Your own instance, as you open it in a browser. Leave empty for Postiz cloud.
            {postiz?.api_url ? ` Calling ${postiz.api_url}.` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-post-type" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>What an import makes:</label>
          <select
            id="postiz-post-type"
            value={settings.postiz_post_type || 'draft'}
            onChange={(e) => saveSettings({ settings: { postiz_post_type: e.target.value as 'draft' | 'schedule' | 'now' } })}
            style={inputStyle}
          >
            {/* Draft first and by default: it is the only one of the three that
                cannot reach an audience by accident. */}
            <option value="draft">A draft, for you to send</option>
            <option value="schedule">A scheduled post</option>
            <option value="now">Posted immediately</option>
          </select>
        </div>

        {/* The calendar an import files against, asked in the same words and
            the same order as the YouTube one above: the two publish one set of
            clips, and a user comparing them should be comparing answers rather
            than working out whether the questions match. Asked whatever an
            import makes, because a draft has a date too — it is where it sits
            on the calendar the user is about to look at. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-start-date" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>First post lands on:</label>
          <DateField
            id="postiz-start-date"
            value={settings.postiz_schedule_start_date || ''}
            onCommit={(value) => saveSettings({ settings: { postiz_schedule_start_date: value } })}
            min={earliestScheduleDate()}
            max={latestScheduleDate()}
            style={inputStyle}
          />
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Empty starts as soon as a post may be placed, which is an hour ahead of the import —
            near enough to be today's calendar, far enough to still be cancellable. Today at the
            earliest, and at most {MAX_SCHEDULE_YEARS_AHEAD} years out.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-per-day" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>How many land per day:</label>
          <select
            id="postiz-per-day"
            value={String(settings.postiz_per_day ?? 0)}
            onChange={(e) => saveSettings({ settings: { postiz_per_day: Number(e.target.value) } })}
            style={inputStyle}
          >
            {PER_DAY_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            A clip keeps its slot however it was imported, so re-importing one moves nothing.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <span style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Spread between:</span>
          <div
            role="group"
            aria-label="Hours Postiz posts land between"
            style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}
          >
            <label htmlFor="postiz-day-start" style={{ fontSize: '0.8rem' }}>From</label>
            <select
              id="postiz-day-start"
              value={String(settings.postiz_day_start_hour ?? 9)}
              onChange={(e) => saveSettings({ settings: { postiz_day_start_hour: Number(e.target.value) } })}
              style={{ ...inputStyle, width: 'auto' }}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>{hourLabel(hour)}</option>
              ))}
            </select>
            <label htmlFor="postiz-day-end" style={{ fontSize: '0.8rem' }}>to</label>
            <select
              id="postiz-day-end"
              value={String(settings.postiz_day_end_hour ?? 21)}
              onChange={(e) => saveSettings({ settings: { postiz_day_end_hour: Number(e.target.value) } })}
              style={{ ...inputStyle, width: 'auto' }}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>{hourLabel(hour)}</option>
              ))}
            </select>
          </div>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            On this machine's clock. One post a day goes out at the first hour; the rest of a day's
            posts are spaced evenly up to the last.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-text" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>What each post says:</label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Leave empty and each channel gets what the model wrote for its platform.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="postiz-comment" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Comment under the post:</label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            {/* Why anyone wants this, said once: it is not obvious that the
                link is better off out of the post itself. */}
            Posted as a thread or first comment where the platform has one — most platforms show a
            post less if it carries an outbound link. Left out when it renders empty.
          </span>
          <DescriptionFieldHelp extra={POSTIZ_FIELDS} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem', minHeight: '44px' }}>
            <input
              type="checkbox"
              // Default on: a configured Postiz is one somebody set up in order
              // to send things to it, and a clip that is ready an hour before
              // its draft appears helped nobody.
              checked={settings.postiz_import_on_render !== false}
              onChange={(e) => saveSettings({ settings: { postiz_import_on_render: e.target.checked } })}
            />
            Import each clip as soon as it is cut
          </label>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            The first clip's draft appears while the last one is still encoding. Off, clips are
            filed by the Postiz Drafts step instead, once you run it.
          </span>
        </div>

        {/* Which accounts. Read from Postiz rather than typed, because the ids
            a post is addressed by are not something anyone knows by heart. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', border: 'var(--border)', padding: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Channels:</label>
          {!postiz?.configured && (
            <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>
              Add an API key above to see the connected channels.
            </span>
          )}
          {postiz?.configured && postiz.error && (
            <span role="alert" style={{ fontSize: '0.8rem', color: 'var(--error)', fontWeight: 'bold', overflowWrap: 'anywhere' }}>
              {postiz.error}
            </span>
          )}
          {postiz?.channels?.length === 0 && (
            <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>
              This Postiz account has no channels connected yet.
            </span>
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
          {/* Some platforms need something only you can supply — a Discord
              channel id, a subreddit. Postiz refuses the post without it and
              says which field it wanted, and that message appears on the clip.
              This is where the answer goes. Free-form on purpose: which field
              each platform wants is Postiz's business and changes with it, so
              this app does not keep a copy of that list. */}
          {selectedChannels.length > 0 && (
            <details style={{ fontSize: '0.8rem' }}>
              <summary style={{ cursor: 'pointer', minHeight: '44px', display: 'flex', alignItems: 'center' }}>
                Extra settings for a channel
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginTop: 'var(--space-sm)' }}>
                {(postiz?.channels || [])
                  .filter((channel) => selectedChannels.includes(channel.id))
                  .map((channel) => (
                    <div key={channel.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
                      <label htmlFor={`postiz-extra-${channel.id}`} style={{ fontWeight: 'bold' }}>
                        {channel.name || channel.id}
                        {channel.identifier ? ` (${channel.identifier})` : ''}
                      </label>
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
                    </div>
                  ))}
              </div>
            </details>
          )}
          {(postiz?.channels?.length ?? 0) > 0 && selectedChannels.length === 0 && (
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              Nothing ticked, so nothing is imported. Clips only go where you say.
            </span>
          )}
        </div>
      </section>

      {/* Video Defaults Section */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>Video Defaults</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Resolution:</label>
          <select 
            value={settings.video_defaults?.resolution || 'keep original'}
            onChange={(e) => updateMutation.mutate({ settings: { video_defaults: { ...settings.video_defaults, resolution: e.target.value } } })}
            style={inputStyle}
          >
            <option value="keep original">keep original</option>
            {Object.keys(resolutionsData ?? {}).map(opt => <option key={opt} value={opt}>{opt.toUpperCase()}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Aspect Ratio:</label>
          <select 
            value={settings.video_defaults?.aspect_ratio || 'keep original'}
            onChange={(e) => updateMutation.mutate({ settings: { video_defaults: { ...settings.video_defaults, aspect_ratio: e.target.value } } })}
            style={inputStyle}
          >
            <option value="keep original">keep original</option>
            {Object.keys(aspectRatiosData ?? {}).map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Encoder Codec (e.g. h264_videotoolbox):</label>
          <input
            type="text"
            value={settings.codec || 'libx264'}
            onChange={(e) => updateMutation.mutate({ settings: { codec: e.target.value } })}
            style={inputStyle}
          />
        </div>

        {/* Only the starting point for new projects. Each project keeps its own
            caption settings from then on, styled on its clip pages. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Captions on new projects:</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', minHeight: '44px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={Boolean(settings.caption_defaults?.enabled)}
              onChange={(e) => updateMutation.mutate({
                settings: { caption_defaults: { ...settings.caption_defaults, enabled: e.target.checked } },
              })}
              style={{ width: '20px', height: '20px', accentColor: 'var(--accent)' }}
            />
            <span style={{ fontSize: '0.9rem' }}>Burn captions into clips by default</span>
          </label>
          <select
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
          {captionOverrideCount > 0 && (
            <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              {captionOverrideCount} adjustment{captionOverrideCount === 1 ? '' : 's'} on top of the
              preset, promoted from a project.{' '}
              <button
                type="button"
                className="text-action"
                onClick={() => saveSettings({
                  settings: { caption_defaults: { ...settings.caption_defaults, overrides: {} } },
                })}
              >
                Back to the plain preset
              </button>
            </span>
          )}
        </div>

        {/* Set from a project rather than here: a title look is judged against
            real clips, and a project's Overlay titles dialog is where it is
            settled and promoted from. This says what was promoted, and offers
            the only thing this page can usefully do to it. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Overlay titles on new projects:</label>
          <span style={{ fontSize: '0.9rem' }}>
            {overlayDefaults
              ? `${overlayDefaults.enabled ? 'Burned into clips' : 'Thumbnails only'} · ${overlayDefaults.font_family ?? 'default font'} · ${overlayDefaults.font_size_pct ?? '—'}% of frame · ${overlayDefaults.position_pct ?? '—'}% from top`
              : 'Not set — new projects start with titles off, drawn on the thumbnails only.'}
          </span>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Set this from a project: open <strong>Overlay titles</strong> in its settings, style it
            there, then save it as the application default.
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
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label htmlFor="clip-preview-default" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>Card preview on new projects:</label>
          <select
            id="clip-preview-default"
            value={settings.clip_preview_default === 'video' ? 'video' : 'thumbnail'}
            onChange={(e) => updateMutation.mutate({
              settings: { clip_preview_default: e.target.value },
            })}
            style={inputStyle}
          >
            <option value="thumbnail">Thumbnail</option>
            <option value="video">Video frame</option>
          </select>
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            What a clip card shows while it sits still. Each project can change its own.
          </span>
        </div>
      </section>

      {/* Highlights Section. Read when the step runs rather than copied into a
          project at creation, so a change here moves every project that has not
          answered for itself — on its next run, never on highlights already
          found. */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>Highlights</h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.8, margin: 0 }}>
          What a highlights run asks for: how many segments it returns, and how long one may be.
          These are hard limits the model rejects against, not preferences. A project can disagree
          with any of them in its own settings.
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
          {highlightNumberField('min_clips', 'Fewest clips', MAX_HIGHLIGHT_CLIPS, '')}
          {highlightNumberField('max_clips', 'Most clips', MAX_HIGHLIGHT_CLIPS, '')}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
          {highlightNumberField('min_duration', 'Shortest clip (seconds)', MAX_HIGHLIGHT_DURATION, 's')}
          {highlightNumberField('max_duration', 'Longest clip (seconds)', MAX_HIGHLIGHT_DURATION, 's')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <label htmlFor="highlight-guidance" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>
            What counts as a highlight:
          </label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Added to the prompt as standing instructions. They outrank its own preferences but not
            its rules — the loop test, the verbatim text and the timings still hold.
          </span>
        </div>
      </section>

      {/* YouTube Description Section. Unlike the caption defaults above, these
          are read when a clip is uploaded rather than copied into a project, so
          editing them changes what every existing project publishes. */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>YouTube Descriptions</h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.8, margin: 0 }}>
          The description every clip is uploaded with. The link back to the original video and any
          text belonging to one project are set on that project's page.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="description-global-text" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>
            Text on every description:
          </label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Placed wherever the template says {'{global.text}'}.
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          <label htmlFor="description-template" style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '0.9rem' }}>
            Description template:
          </label>
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
          <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>
            Leave empty to use the template shown above. Anything you type is used exactly as
            written; a field in braces is replaced with its value.
          </span>
          <DescriptionFieldHelp />
        </div>
      </section>

      {/* Pipeline Configuration Section */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', textTransform: 'uppercase', fontWeight: 900 }}>Pipeline Defaults</h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.8, margin: 0 }}>Configure the execution order and auto-run settings for the project pipeline.</p>
        
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
                      pipeline_config: newConfig 
                    });
                  }}
                  style={{ cursor: 'pointer' }}
                />
                Auto-run
              </label>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
};
