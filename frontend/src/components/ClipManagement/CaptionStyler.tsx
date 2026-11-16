import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { CaptionControls } from './CaptionControls';
import { PromoteToDefaults } from '../PromoteToDefaults';
import {
  getCaptionStyles,
  updateProjectSettings,
  type CaptionSettings,
  type CaptionStyle,
} from '../../api';

interface CaptionStylerProps {
  projectId: string;
  /** What the project currently has stored, or undefined for an older project. */
  settings: CaptionSettings | undefined;
  /**
   * The resolved style from a clip preview, when there is one. Optional: the
   * project page has no clip in hand, and the preset map is enough to open the
   * controls on the right values there.
   */
  style?: CaptionStyle | undefined;
  /**
   * How the trigger presents itself.
   *
   * `panel` is a full-width row with a summary line under it, for a column that
   * has the vertical space. `inline` is one text action carrying its state
   * badge, for the project page's options bar, where it stands beside five
   * other options and a summary line each would be five stacked sentences.
   */
  variant?: 'panel' | 'inline';
}

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  enabled: false,
  preset: 'karaoke_pop',
  overrides: {},
};

/**
 * The project's caption settings, behind a button.
 *
 * These are the defaults every clip follows unless it has unlocked its own, so
 * they belong to the project rather than to any one clip — but they are also
 * set once and rarely revisited, which is why the whole form lives in a dialog
 * instead of holding open a column of the page.
 *
 * Every change is written to the project rather than held in the page: the
 * clipper reads the same stored settings when it burns the captions in, so what
 * is on screen is a promise about the render. Writes are debounced because a
 * slider drag would otherwise be a hundred of them.
 */
export const CaptionStyler: React.FC<CaptionStylerProps> = ({ projectId, settings, style, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const { data: presets } = useQuery({ queryKey: ['captionStyles'], queryFn: getCaptionStyles });
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState<CaptionSettings | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = pending ?? settings ?? DEFAULT_CAPTION_SETTINGS;

  const mutation = useMutation({
    mutationFn: (next: CaptionSettings) => updateProjectSettings(projectId, { captions: next }),
    onSuccess: () => {
      // The cues themselves change with words_per_cue, so the preview payload
      // is refetched rather than just re-styled.
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      queryClient.invalidateQueries({ queryKey: ['clipCaptions', projectId] });
    },
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const commit = (next: CaptionSettings) => {
    setPending(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => mutation.mutate(next), 250);
  };

  // Overrides sit on top of the chosen preset, which is exactly what the
  // backend resolves. Reading the base from the preset map rather than from
  // `style` also means switching preset moves the controls immediately, instead
  // of waiting for the preview to come back with the new resolved style.
  const base = presets?.[current.preset] ?? style;
  const overrideCount = Object.keys(current.overrides).length;

  // The summary is the point of collapsing this: the trigger has to say what
  // the dialog behind it would show, or a customised project looks identical
  // to an untouched one. The panel variant has a line under it to say so; the
  // inline one has only the badge, so the badge has to carry it.
  const badgeText = (suffix: boolean) =>
    `${current.enabled ? 'On' : 'Off'}${suffix && overrideCount > 0 ? ` · ${overrideCount} adjusted` : ''}`;

  const badge = (suffix: boolean) => (
    <span
      className="status-badge"
      style={current.enabled ? { background: 'var(--success)', color: 'var(--on-success)' } : undefined}
    >
      {badgeText(suffix)}
    </span>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          Captions
          {badge(true)}
        </button>
      ) : (
        <>
          <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
            <span>Captions</span>
            {badge(false)}
          </button>
          <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {presets?.[current.preset]?.label ?? current.preset}
            {overrideCount > 0 && ` · ${overrideCount} adjusted`}
            {' · applies to every clip that has not unlocked its own'}
          </p>
        </>
      )}

      <Modal isOpen={isOpen} title="Project captions" onClose={() => setIsOpen(false)}>
        <p style={{ margin: '0 0 var(--space-md) 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {current.enabled
            ? 'Clips you render will have these captions burned into the video, unless a clip has unlocked its own.'
            : 'Clips render without captions. Your style choices are saved for when you turn this on.'}
        </p>

        <CaptionControls
          idPrefix="project-caption"
          value={current}
          onChange={commit}
          presets={presets}
          base={base}
        />

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save these caption settings. Clips would render with the last saved style, not this one.
          </p>
        )}

        {/* The style is settled here, against real clips — this is where the
            user finds out what they want every project to look like. */}
        <PromoteToDefaults
          build={() => ({ caption_defaults: current })}
          hint="New projects start with this preset, these adjustments and this on/off state. Projects that already exist keep their own."
        />
      </Modal>
    </>
  );
};
