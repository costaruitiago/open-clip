import React, { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { DateField } from '../DateField';
import { PromoteToDefaults } from '../PromoteToDefaults';
import {
  getYoutubeStatus,
  updateProjectSettings,
  type UploadPrivacy,
  type UploadProjectSettings,
} from '../../api';
import {
  HOURS,
  PER_DAY_CHOICES,
  PRIVACY_LABELS,
  earliestScheduleDate,
  hourLabel,
  latestScheduleDate,
} from '../../utils/uploadSchedule';

interface UploadPanelProps {
  projectId: string;
  /** What the project has stored, or undefined for one created before this existed. */
  settings: UploadProjectSettings | undefined;
  /** See CaptionStyler: `panel` is a row with a summary, `inline` is one text action. */
  variant?: 'panel' | 'inline';
}

const EMPTY: UploadProjectSettings = {
  channel_id: null,
  privacy: null,
  per_day: null,
  start_date: null,
  day_start_hour: null,
  day_end_hour: null,
};

/** What the badge says, which is the shortest true thing about the setting. */
const BADGE_LABELS: Record<UploadPrivacy, string> = {
  private: 'Private',
  unlisted: 'Unlisted',
  public: 'Public',
  schedule: 'Scheduled',
};

/**
 * How this project's clips go up on YouTube, when that is not how the rest go.
 *
 * Publishing is the one thing this app does that it cannot undo, and one
 * install cuts a company's podcast and somebody's side project: the two do not
 * go public on the same terms. Settings holds the default; this is where a
 * project disagrees with it.
 *
 * Following the application is a state of its own rather than a copy of its
 * answer — the difference matters, because a copy stops following the moment
 * the default changes, and picking a date here says nothing about wanting the
 * privacy frozen too.
 */
export const UploadPanel: React.FC<UploadPanelProps> = ({ projectId, settings, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const channelId = useId();
  const privacyId = useId();
  const startDateId = useId();
  const perDayId = useId();
  const dayStartId = useId();
  const dayEndId = useId();

  // Asked only while the dialog is open: all this page wants from it is the
  // channels to pick from and the defaults to name, and it is a round trip
  // that says nothing otherwise.
  const { data: youtube } = useQuery({
    queryKey: ['youtubeStatus'],
    queryFn: getYoutubeStatus,
    enabled: isOpen,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (next: Partial<UploadProjectSettings>) =>
      updateProjectSettings(projectId, { upload: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    },
  });

  const stored = settings ?? EMPTY;
  const appPrivacy = youtube?.privacy ?? 'private';
  // What would actually happen: this project's answer, or the one it is
  // following. The schedule fields are shown under either, because a project
  // that follows a scheduled default is on a schedule.
  const effective: UploadPrivacy = stored.privacy ?? appPrivacy;

  const channels = youtube?.channels ?? [];
  const channelTitle = (id: string | null | undefined) =>
    channels.find((channel) => channel.id === id)?.title ?? id;
  // A channel this project picked and Settings has since disconnected is kept
  // as an option, so the select shows what uploads will fail on.
  const missingChannel =
    youtube && stored.channel_id && !channels.some((channel) => channel.id === stored.channel_id)
      ? stored.channel_id
      : null;

  // Everything this project decided for itself. The privacy is only one of the
  // five: a project that follows the default privacy but publishes on its own
  // calendar is not following Settings, and the badge said it was.
  const chosen = (Object.keys(EMPTY) as (keyof UploadProjectSettings)[]).filter(
    (key) => stored[key] !== null && stored[key] !== undefined && stored[key] !== ''
  );

  // One choice is named rather than counted — "Private" says more than "1
  // chosen", and a lone date or hour is worth naming too. Past that there is no
  // room for a list, so the count stands in for it.
  const badgeLabel = () => {
    if (chosen.length === 0) return 'Default';
    if (chosen.length > 1) return `${chosen.length} chosen`;
    if (stored.privacy) return BADGE_LABELS[stored.privacy];
    return stored.channel_id ? 'Own channel' : '1 chosen';
  };

  const badge = (
    <span
      className="status-badge"
      style={
        chosen.length === 0
          ? undefined
          : { background: 'var(--accent)', color: 'var(--on-accent, var(--bg))' }
      }
    >
      {badgeLabel()}
    </span>
  );

  const labelStyle: React.CSSProperties = {
    fontWeight: 900,
    fontSize: '0.65rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };

  const fieldStyle: React.CSSProperties = {
    padding: 'var(--space-sm)',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: 'var(--border)',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    width: '100%',
    minHeight: '44px',
  };

  const hintStyle: React.CSSProperties = {
    fontSize: '0.7rem',
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  };

  /** A number field: an empty option is "follow Settings", not a value. */
  const numberChange = (key: keyof UploadProjectSettings) => (value: string) =>
    mutation.mutate({ [key]: value === '' ? null : Number(value) });

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          YouTube
          {badge}
        </button>
      ) : (
        <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
          <span>YouTube</span>
          {badge}
        </button>
      )}

      <Modal isOpen={isOpen} title="YouTube upload settings" onClose={() => setIsOpen(false)} maxWidth="620px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            {/* A dropdown with one entry is not a choice, so one channel is
                stated rather than offered. */}
            {channels.length > 1 || missingChannel ? (
              <>
                <label htmlFor={channelId} style={labelStyle}>Channel</label>
                <select
                  id={channelId}
                  value={stored.channel_id ?? ''}
                  onChange={(e) => mutation.mutate({ channel_id: e.target.value || null })}
                  style={fieldStyle}
                >
                  <option value="">
                    Default{youtube?.default_channel ? `: ${channelTitle(youtube.default_channel)}` : ''}
                  </option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>{channel.title}</option>
                  ))}
                  {missingChannel && (
                    <option value={missingChannel}>{missingChannel} (not connected)</option>
                  )}
                </select>
                {missingChannel && (
                  <span style={{ ...hintStyle, color: 'var(--error)' }}>
                    This channel is no longer connected. Uploads will fail until you pick another
                    or connect it again in Settings.
                  </span>
                )}
              </>
            ) : (
              <>
                <span style={labelStyle}>Channel</span>
                <span style={{ fontSize: '0.9rem' }}>
                  {channels.length === 1 ? channels[0].title : 'No channel connected'}
                </span>
                <span style={hintStyle}>
                  To upload somewhere else, connect another channel in Settings → YouTube.
                </span>
              </>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={privacyId} style={labelStyle}>Visibility</label>
            <select
              id={privacyId}
              value={stored.privacy ?? ''}
              onChange={(e) =>
                mutation.mutate({ privacy: (e.target.value || null) as UploadPrivacy | null })
              }
              style={fieldStyle}
            >
              <option value="">Default: {PRIVACY_LABELS[appPrivacy] ?? appPrivacy}</option>
              {(Object.keys(PRIVACY_LABELS) as UploadPrivacy[]).map((value) => (
                <option key={value} value={value}>{PRIVACY_LABELS[value]}</option>
              ))}
            </select>
            <span style={hintStyle}>Applies to new uploads only.</span>
          </div>

          {/* Only under a schedule, for the same reason as in Settings: these
              say nothing about a clip that is public the moment it lands. */}
          {effective === 'schedule' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                <label htmlFor={startDateId} style={labelStyle}>Start date</label>
                <DateField
                  id={startDateId}
                  value={stored.start_date ?? ''}
                  onCommit={(value) => mutation.mutate({ start_date: value || null })}
                  min={earliestScheduleDate()}
                  max={latestScheduleDate()}
                  style={fieldStyle}
                />
                <span style={hintStyle}>Empty uses the default. No default means as soon as uploaded.</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                <label htmlFor={perDayId} style={labelStyle}>Clips per day</label>
                <select
                  id={perDayId}
                  // An empty string is "follow Settings" and 0 is "all at the
                  // same moment" — two different answers, which is why the
                  // value is not simply the number.
                  value={stored.per_day === null ? '' : String(stored.per_day)}
                  onChange={(e) => numberChange('per_day')(e.target.value)}
                  style={fieldStyle}
                >
                  <option value="">Default</option>
                  {PER_DAY_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                <span style={labelStyle}>Publish between</span>
                <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                  <label htmlFor={dayStartId} style={{ fontSize: '0.8rem' }}>From</label>
                  <select
                    id={dayStartId}
                    value={stored.day_start_hour === null ? '' : String(stored.day_start_hour)}
                    onChange={(e) => numberChange('day_start_hour')(e.target.value)}
                    style={{ ...fieldStyle, width: 'auto' }}
                  >
                    <option value="">Default</option>
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>{hourLabel(hour)}</option>
                    ))}
                  </select>
                  <label htmlFor={dayEndId} style={{ fontSize: '0.8rem' }}>to</label>
                  <select
                    id={dayEndId}
                    value={stored.day_end_hour === null ? '' : String(stored.day_end_hour)}
                    onChange={(e) => numberChange('day_end_hour')(e.target.value)}
                    style={{ ...fieldStyle, width: 'auto' }}
                  >
                    <option value="">Default</option>
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>{hourLabel(hour)}</option>
                    ))}
                  </select>
                </div>
                <span style={hintStyle}>Your local time.</span>
              </div>
            </>
          )}
        </div>

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save that. Uploads would use the last saved setting, not this one.
          </p>
        )}

        {/* Only what this project decided, like the Postiz panel — and the
            schedule fields travel whether or not this project is scheduled, for
            the same reason they are kept here: a calendar somebody typed out is
            not thrown away for a week on private. */}
        {chosen.length > 0 && (
          <PromoteToDefaults
            build={() => {
              const next: Record<string, unknown> = {};
              if (stored.channel_id) next.youtube_channel = stored.channel_id;
              if (stored.privacy) next.youtube_privacy = stored.privacy;
              if (stored.per_day !== null) next.youtube_schedule_per_day = stored.per_day;
              if (stored.start_date) next.youtube_schedule_start_date = stored.start_date;
              if (stored.day_start_hour !== null) next.youtube_schedule_day_start_hour = stored.day_start_hour;
              if (stored.day_end_hour !== null) next.youtube_schedule_day_end_hour = stored.day_end_hour;
              return next;
            }}
            hint="Makes this project's choices the default for every project."
          />
        )}
      </Modal>
    </>
  );
};
