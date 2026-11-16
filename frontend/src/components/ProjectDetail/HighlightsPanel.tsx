import React, { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { PromoteToDefaults } from '../PromoteToDefaults';
import {
  getSettings,
  updateProjectSettings,
  type HighlightProjectSettings,
  type SettingsResponse,
} from '../../api';
import {
  MAX_HIGHLIGHT_CLIPS,
  MAX_HIGHLIGHT_DURATION,
  effectiveHighlight,
  formatSeconds,
  type HighlightNumberField,
} from '../../utils/highlightOptions';

interface HighlightsPanelProps {
  projectId: string;
  /** What the project has stored, or undefined for one created before this existed. */
  settings: HighlightProjectSettings | undefined;
  /** See CaptionStyler: `panel` is a row with a summary, `inline` is one text action. */
  variant?: 'panel' | 'inline';
}

const EMPTY: HighlightProjectSettings = {
  min_clips: null,
  max_clips: null,
  min_duration: null,
  max_duration: null,
  guidance: '',
};

/**
 * What this project asks a highlights run for, when it is not what the rest ask.
 *
 * How many segments to find and how long they may run were sentences in the
 * prompt file, which made every project a podcast cut into 7–12 shorts. A
 * two-hour interview holds more good moments than a ten-minute talk, and a
 * Reel and a YouTube Short are not the same length — so the run is told, per
 * project, rather than the file being edited for whichever project is next.
 *
 * Empty is "follow Settings" rather than a copy of its answer: the difference
 * matters, because a copy stops following the moment the default changes.
 * Nothing here touches highlights that have already been found — it is read
 * when the step next runs.
 */
export const HighlightsPanel: React.FC<HighlightsPanelProps> = ({
  projectId,
  settings,
  variant = 'panel',
}) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const minClipsId = useId();
  const maxClipsId = useId();
  const minDurationId = useId();
  const maxDurationId = useId();
  const guidanceId = useId();

  // Asked only while the dialog is open, like the upload panel's status: all
  // this wants from it is the default to name under each empty field.
  const { data: appSettings } = useQuery<SettingsResponse>({
    queryKey: ['settings'],
    queryFn: getSettings as () => Promise<SettingsResponse>,
    enabled: isOpen,
  });
  const appDefaults = appSettings?.settings?.highlight_defaults;

  const stored = settings ?? EMPTY;

  // What is being typed, so a background metadata refresh cannot overwrite a
  // half-written number or sentence. Re-synced only while the dialog is shut.
  const [guidanceDraft, setGuidanceDraft] = useState(stored.guidance);
  useEffect(() => {
    if (!isOpen) setGuidanceDraft(settings?.guidance ?? '');
  }, [settings, isOpen]);

  const mutation = useMutation({
    mutationFn: (next: Partial<HighlightProjectSettings>) =>
      updateProjectSettings(projectId, { highlights: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    },
  });

  const hasOwn =
    stored.min_clips !== null ||
    stored.max_clips !== null ||
    stored.min_duration !== null ||
    stored.max_duration !== null ||
    stored.guidance.trim() !== '';

  const badge = (
    <span
      className="status-badge"
      style={hasOwn ? { background: 'var(--accent)', color: 'var(--on-accent, var(--bg))' } : undefined}
    >
      {hasOwn
        ? `${effectiveHighlight('min_clips', stored, appDefaults)}–${effectiveHighlight('max_clips', stored, appDefaults)} clips`
        : 'Default'}
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

  const hintStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  };

  /**
   * One number, saved when the user leaves the field.
   *
   * Empty is null — "follow Settings" — and not zero: a run that must return
   * between zero and zero clips is not a setting anybody meant to type. A
   * value out of range is dropped rather than sent, because the backend would
   * drop it anyway and the field would then show a number nothing is using.
   */
  const commitNumber = (field: HighlightNumberField, max: number) => (raw: string) => {
    const text = raw.trim();
    if (text === '') {
      if (stored[field] !== null) mutation.mutate({ [field]: null });
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 1 || value > max) return;
    if (stored[field] === value) return;
    mutation.mutate({ [field]: value });
  };

  const numberField = (
    id: string,
    label: string,
    field: HighlightNumberField,
    max: number,
    unit: string
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', flex: 1 }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        // Keyed by the stored value so clearing a field and leaving it puts the
        // placeholder back rather than the number that was there — an
        // uncontrolled input is what lets the field be empty at all, and
        // without the key it would keep the text the user deleted.
        key={`${field}-${String(stored[field])}`}
        defaultValue={stored[field] === null ? '' : String(stored[field])}
        placeholder={String(effectiveHighlight(field, undefined, appDefaults))}
        onBlur={(e) => commitNumber(field, max)(e.target.value)}
        style={fieldStyle}
      />
      <span style={hintStyle}>
        Empty follows Settings, which is {formatSeconds(effectiveHighlight(field, undefined, appDefaults))}
        {unit}.
      </span>
    </div>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          Highlights
          {badge}
        </button>
      ) : (
        <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
          <span>Highlights</span>
          {badge}
        </button>
      )}

      <Modal
        isOpen={isOpen}
        title="Highlights for this project"
        onClose={() => setIsOpen(false)}
        maxWidth="620px"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
            {numberField(minClipsId, 'Fewest clips', 'min_clips', MAX_HIGHLIGHT_CLIPS, '')}
            {numberField(maxClipsId, 'Most clips', 'max_clips', MAX_HIGHLIGHT_CLIPS, '')}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
            {numberField(
              minDurationId,
              'Shortest clip (seconds)',
              'min_duration',
              MAX_HIGHLIGHT_DURATION,
              's'
            )}
            {numberField(
              maxDurationId,
              'Longest clip (seconds)',
              'max_duration',
              MAX_HIGHLIGHT_DURATION,
              's'
            )}
          </div>

          <span style={hintStyle}>
            These are hard limits the model is told to reject against, not preferences: a segment
            outside them is not returned at all. A long interview holds more good moments than a
            short talk, which is why the count is asked here rather than fixed.
          </span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <label htmlFor={guidanceId} style={labelStyle}>What counts as a highlight here</label>
            <textarea
              id={guidanceId}
              value={guidanceDraft}
              onChange={(e) => setGuidanceDraft(e.target.value)}
              onBlur={() => {
                if (guidanceDraft !== stored.guidance) mutation.mutate({ guidance: guidanceDraft });
              }}
              placeholder="e.g. prefer the guest over the host, and skip anything about pricing"
              style={{ ...fieldStyle, minHeight: '110px', lineHeight: 1.4 }}
            />
            <span style={hintStyle}>
              Added to the prompt as your own instructions. They outrank the prompt's own
              preferences but not its rules — the loop test, the verbatim text and the timings
              still hold. Empty follows Settings.
            </span>
          </div>

          <span style={hintStyle}>
            Nothing here changes highlights that have already been found. Re-run the Highlights
            step to use it, which replaces the ones on this project.
          </span>
        </div>

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save that. The next run would use the last saved setting, not this one.
          </p>
        )}

        {/* Only what this project decided. The application's key is stored
            whole, so the half this project has no opinion on is rebuilt from
            what the application already holds rather than blanked. */}
        <PromoteToDefaults
          build={(current) => {
            const own: Record<string, unknown> = {};
            (['min_clips', 'max_clips', 'min_duration', 'max_duration'] as const).forEach((field) => {
              if (stored[field] !== null) own[field] = stored[field];
            });
            if (stored.guidance.trim()) own.guidance = stored.guidance;
            if (Object.keys(own).length === 0) return {};
            return { highlight_defaults: { ...(current.highlight_defaults ?? {}), ...own } };
          }}
          hint="Every project that has not chosen for itself asks for this, on its next run."
          emptyHint="This project follows Settings for everything here, so there is nothing of its own to promote."
        />
      </Modal>
    </>
  );
};
