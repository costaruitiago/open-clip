import React, { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { DateField } from '../DateField';
import { DescriptionFieldHelp } from '../DescriptionFieldHelp';
import { PromoteToDefaults } from '../PromoteToDefaults';
import {
  getPostizStatus,
  updateProjectSettings,
  type PostizProjectSettings,
} from '../../api';
import {
  HOURS,
  MAX_SCHEDULE_YEARS_AHEAD,
  PER_DAY_CHOICES,
  earliestScheduleDate,
  hourLabel,
  latestScheduleDate,
} from '../../utils/uploadSchedule';

interface PostizPanelProps {
  projectId: string;
  /** What the project has stored, or undefined for one created before this existed. */
  settings: PostizProjectSettings | undefined;
  /** See CaptionStyler: `panel` is a row with a summary, `inline` is one text action. */
  variant?: 'panel' | 'inline';
}

const EMPTY: PostizProjectSettings = {
  channels: null,
  post_type: null,
  channel_settings: {},
  per_day: null,
  start_date: null,
  day_start_hour: null,
  day_end_hour: null,
  text_template: '',
  comment_template: '',
};

/** Fields that mean something in a Postiz post and nothing in a YouTube description. */
const POSTIZ_FIELDS = [
  {
    field: 'platform.post',
    description: 'What the model wrote for the platform this post is going to',
  },
  { field: 'platform.name', description: 'The platform itself, e.g. x, linkedin' },
];

/**
 * Where this project's clips go, when that is not where everything else goes.
 *
 * One machine has one Postiz account, and the projects on it are not one thing:
 * a company's podcast and somebody's side project are cut on the same install
 * and must not land in the same accounts. Settings holds the default; this is
 * where a project disagrees with it.
 *
 * Following the application is a state of its own rather than a copy of its
 * list — the difference matters, because a copy stops following the moment the
 * default changes, and nothing about ticking boxes here says the user meant to
 * freeze them.
 */
export const PostizPanel: React.FC<PostizPanelProps> = ({ projectId, settings, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const postTypeId = useId();
  const perDayId = useId();
  const startDateId = useId();
  const dayStartId = useId();
  const dayEndId = useId();
  const textId = useId();
  const commentId = useId();

  // Asked only while the dialog is open: it is a round trip to Postiz, and the
  // channel list is not something the project page needs otherwise.
  const { data: postiz } = useQuery({
    queryKey: ['postizStatus'],
    queryFn: getPostizStatus,
    enabled: isOpen,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: (next: Partial<PostizProjectSettings>) =>
      updateProjectSettings(projectId, { postiz: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    },
  });

  const stored = settings ?? EMPTY;
  const follows = stored.channels === null;

  // The two templates are paragraphs typed once, so they are held locally and
  // written when the user leaves the box — and re-synced only while the dialog
  // is closed, so a background metadata refresh cannot overwrite half a
  // sentence someone is still typing.
  const [text, setText] = useState(stored.text_template ?? '');
  const [comment, setComment] = useState(stored.comment_template ?? '');
  useEffect(() => {
    if (!isOpen) {
      setText(settings?.text_template ?? '');
      setComment(settings?.comment_template ?? '');
    }
  }, [settings, isOpen]);

  // What the boxes show: this project's choice, or — while it follows — the
  // application's, so the ticks read as what would actually happen.
  const ticked = follows ? postiz?.selected_channels ?? [] : stored.channels ?? [];

  const toggle = (id: string) => {
    const next = ticked.includes(id) ? ticked.filter((entry) => entry !== id) : [...ticked, id];
    // The first tick is also the moment this project stops following the
    // application, which is why an empty list is sent rather than null.
    mutation.mutate({ channels: next });
  };

  // Everything this project decided for itself. The channel list is only one of
  // the nine: a project that imports to the default channels but on its own
  // calendar, or with its own wording, is not following Settings, and the badge
  // said it was.
  const chosen = (Object.keys(EMPTY) as (keyof PostizProjectSettings)[]).filter((key) => {
    // The one setting with no null: it is layered per channel, so "no opinion"
    // is an empty map rather than a missing one.
    if (key === 'channel_settings') return Object.keys(stored.channel_settings ?? {}).length > 0;
    const value = stored[key];
    return value !== null && value !== undefined && value !== '';
  });

  // The channels are named rather than counted when they are the only choice —
  // "2 channels" says more than "1 chosen", and counting the setting rather
  // than the channels is what made a project with its own list read as one.
  const badgeLabel = () => {
    if (chosen.length === 0) return 'Default';
    if (chosen.length === 1 && !follows) {
      const count = stored.channels?.length ?? 0;
      return `${count} channel${count === 1 ? '' : 's'}`;
    }
    if (chosen.length === 1) return '1 chosen';
    return `${chosen.length} chosen`;
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
    fontWeight: 500,
    fontSize: '0.75rem',
  };

  const fieldStyle: React.CSSProperties = {
    padding: 'var(--space-sm)',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: 'var(--border)', borderRadius: 'var(--radius-lg)',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    width: '100%',
    minHeight: '44px',
  };

  /** A number field: an empty option is "follow Settings", not a value. */
  const numberChange = (key: keyof PostizProjectSettings) => (value: string) =>
    mutation.mutate({ [key]: value === '' ? null : Number(value) });

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          Postiz
          {badge}
        </button>
      ) : (
        <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
          <span>Postiz</span>
          {badge}
        </button>
      )}

      <Modal isOpen={isOpen} title="Postiz for this project" onClose={() => setIsOpen(false)} maxWidth="620px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          {!postiz?.configured && (
            <p style={{ margin: 0, fontSize: '0.8rem' }}>
              Postiz is not set up yet. Add an API key in Settings and the channels appear here.
            </p>
          )}
          {postiz?.error && (
            <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--error)', overflowWrap: 'anywhere' }}>
              {postiz.error}
            </p>
          )}

          {(postiz?.channels?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              <span style={labelStyle}>Channels</span>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {follows
                  ? 'Following Settings: change the default there and this project follows it. Tick anything here and this project stops following and keeps its own list.'
                  : 'This project has its own list. Nothing ticked means it imports nowhere.'}
              </p>
              {(postiz?.channels ?? []).map((channel) => (
                <label
                  key={channel.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', fontSize: '0.85rem', minHeight: '44px' }}
                >
                  <input type="checkbox" checked={ticked.includes(channel.id)} onChange={() => toggle(channel.id)} />
                  <span>
                    {channel.name || channel.id}
                    {channel.identifier ? ` (${channel.identifier})` : ''}
                    {channel.disabled ? ' — disabled in Postiz' : ''}
                  </span>
                </label>
              ))}
              {!follows && (
                // The way back. Without it, a project that has ever been
                // ticked can never follow the default again.
                <button
                  type="button"
                  className="text-action"
                  onClick={() => mutation.mutate({ channels: null })}
                >
                  Follow Settings again
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={postTypeId} style={labelStyle}>What an import makes</label>
            <select
              id={postTypeId}
              value={stored.post_type ?? ''}
              onChange={(e) =>
                mutation.mutate({
                  post_type: (e.target.value || null) as PostizProjectSettings['post_type'],
                })
              }
              style={fieldStyle}
            >
              <option value="">
                Whatever Settings says{postiz?.post_type ? ` (${postiz.post_type})` : ''}
              </option>
              <option value="draft">A draft, for you to send</option>
              <option value="schedule">A scheduled post</option>
              <option value="now">Posted immediately</option>
            </select>
          </div>

          {/* The same three questions the YouTube panel asks, in the same
              order and the same words: one set of clips, one calendar. They
              are asked whatever the import makes, because a draft has a date
              too — it is where it sits on the calendar the user is about to
              look at, which is the whole point of spacing them. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={startDateId} style={labelStyle}>First post lands on</label>
            <DateField
              id={startDateId}
              value={stored.start_date ?? ''}
              onCommit={(value) => mutation.mutate({ start_date: value || null })}
              min={earliestScheduleDate()}
              max={latestScheduleDate()}
              style={fieldStyle}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Empty follows Settings, and Settings with no date starts as soon as a post may be
              placed. Today at the earliest, and at most {MAX_SCHEDULE_YEARS_AHEAD} years out.
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={perDayId} style={labelStyle}>How many land per day</label>
            <select
              id={perDayId}
              // An empty string is "follow Settings" and 0 is "all at the same
              // moment" — two different answers, which is why the value is not
              // simply the number.
              value={stored.per_day === null ? '' : String(stored.per_day)}
              onChange={(e) =>
                mutation.mutate({ per_day: e.target.value === '' ? null : Number(e.target.value) })
              }
              style={fieldStyle}
            >
              <option value="">Whatever Settings says</option>
              {PER_DAY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              A clip keeps its slot however it was imported, so re-importing one moves nothing.
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <span style={labelStyle}>Spread between</span>
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
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              On this machine's clock. One post a day goes out at the first hour; the rest of a
              day's posts are spaced evenly up to the last.
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={textId} style={labelStyle}>What each post says</label>
            <textarea
              id={textId}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                if (text !== (stored.text_template ?? '')) mutation.mutate({ text_template: text });
              }}
              placeholder="Empty: use the template from Settings"
              style={{ ...fieldStyle, minHeight: '110px', fontFamily: 'monospace', lineHeight: 1.4 }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={commentId} style={labelStyle}>Comment under the post</label>
            <textarea
              id={commentId}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onBlur={() => {
                if (comment !== (stored.comment_template ?? '')) {
                  mutation.mutate({ comment_template: comment });
                }
              }}
              placeholder="Empty: use the one from Settings"
              style={{ ...fieldStyle, minHeight: '70px', fontFamily: 'monospace', lineHeight: 1.4 }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Posted as a thread or first comment where the platform has one. Left out when it
              renders empty, so a project with no source URL gets no dangling "Full episode:".
            </span>
            <DescriptionFieldHelp extra={POSTIZ_FIELDS} />
          </div>
        </div>

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save that. Imports would use the last saved setting, not this one.
          </p>
        )}

        {/* Only what this project actually decided. A field it is still
            following is already the application's answer, and sending it back
            would be a no-op at best and, if the default moved since the page
            loaded, a silent revert. */}
        <PromoteToDefaults
          build={(app) => {
            const next: Record<string, unknown> = {};
            if (stored.channels !== null) next.postiz_channels = stored.channels;
            if (stored.post_type) next.postiz_post_type = stored.post_type;
            if (stored.per_day !== null) next.postiz_per_day = stored.per_day;
            if (stored.start_date) next.postiz_schedule_start_date = stored.start_date;
            if (stored.day_start_hour !== null) next.postiz_day_start_hour = stored.day_start_hour;
            if (stored.day_end_hour !== null) next.postiz_day_end_hour = stored.day_end_hour;
            if (text) next.postiz_text_template = text;
            if (comment) next.postiz_comment_template = comment;
            // Layered rather than replaced, the same way a project layers its
            // own over the application's: these are keyed per channel, and this
            // project has only ever had an opinion about the ones it posts to.
            if (Object.keys(stored.channel_settings ?? {}).length > 0) {
              next.postiz_channel_settings = {
                ...(app.postiz_channel_settings ?? {}),
                ...stored.channel_settings,
              };
            }
            return next;
          }}
          hint="These become what every project imports with, unless the project says otherwise. Projects that are still following Settings follow this the moment it is saved."
          emptyHint="This project follows Settings for everything here, so there is nothing of its own to promote."
        />
      </Modal>
    </>
  );
};
