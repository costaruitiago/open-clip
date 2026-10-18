import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { OverlayControls } from './OverlayControls';
import { PromoteToDefaults } from '../PromoteToDefaults';
import {
  DEFAULT_OVERLAY_TEXT,
  updateProjectSettings,
  type OverlayText,
} from '../../api';

interface OverlayStylerProps {
  projectId: string;
  /** What the project currently has stored, or undefined for an older project. */
  overlay: OverlayText | undefined;
  /**
   * How the trigger presents itself.
   *
   * `panel` is a full-width row with a summary line under it, for a column that
   * has the vertical space. `inline` is one text action carrying its state
   * badge, for the project page's options bar. Mirrors `CaptionStyler`.
   */
  variant?: 'panel' | 'inline';
}

/**
 * What a project that has never configured its titles starts from.
 *
 * Switched off, so a project nobody has touched burns nothing into its clips.
 * Wordless because this setting is wordless: the text is never stored here.
 */
const DEFAULT_PROJECT_OVERLAY: OverlayText = {
  ...DEFAULT_OVERLAY_TEXT,
  enabled: false,
  text: '',
};

/**
 * How this project draws a title, behind a button.
 *
 * Configuration only — font, size, placement, colours, timing — and nothing
 * about what any title says. The words are the one thing about a title that
 * cannot be the same on every short, so they belong to the clip; a line stored
 * here would be one line over the whole project at once.
 *
 * Every change is written to the project rather than held in the page: the
 * clipper reads the same stored settings when it burns the title in, so what is
 * on screen is a promise about the render. Writes are debounced because a
 * slider drag would otherwise be a hundred of them.
 */
export const OverlayStyler: React.FC<OverlayStylerProps> = ({ projectId, overlay, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState<OverlayText | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = pending ?? overlay ?? DEFAULT_PROJECT_OVERLAY;

  const mutation = useMutation({
    mutationFn: (next: OverlayText) => updateProjectSettings(projectId, { overlay: next }),
    onSuccess: () => {
      // Every clip draws its title in this, so every clip's preview is stale —
      // not just the project the setting lives on. No clip index on either key:
      // this one change reaches all of them at once.
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      queryClient.invalidateQueries({ queryKey: ['clipCaptions', projectId] });
    },
  });

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const commit = (next: OverlayText, immediate = false) => {
    // Held wordless on the way out as well as on the way in: the controls never
    // show a text box, but the object they edit still carries the field.
    next = { ...next, text: '' };
    setPending(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => mutation.mutate(next), immediate ? 0 : 250);
  };

  /** Sends whatever the debounce is still holding, so closing never loses it. */
  const close = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      mutation.mutate(current);
    }
    setIsOpen(false);
  };

  // The trigger has to say what the dialog behind it would show, and the one
  // thing worth knowing from outside it is whether titles reach the video at
  // all.
  const badge = (
    <span
      className="status-badge"
      style={current.enabled ? { background: 'var(--success)', color: 'var(--on-success)' } : undefined}
    >
      {current.enabled ? 'On' : 'Off'}
    </span>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          Overlay titles
          {badge}
        </button>
      ) : (
        <>
          <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
            <span>Overlay titles</span>
            {badge}
          </button>
          <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {`${current.font_family} · ${current.font_size_pct}% of frame · ${current.position_pct}% from top`}
            {' · how every title in this project is drawn'}
          </p>
        </>
      )}

      <Modal isOpen={isOpen} title="Project overlay titles" onClose={close}>
        <p style={{ margin: '0 0 var(--space-md) 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          How every title in this project is drawn. The words belong to the clip — write them
          with <strong>Add overlay text</strong> on a clip. {current.enabled
            ? 'Titles are burned into rendered clips; regenerate a clip to apply a change to its file.'
            : 'Titles are not burned into the video.'}
        </p>

        <OverlayControls
          idPrefix="project-overlay"
          value={current}
          onChange={commit}
          showText={false}
        />

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save the project title. Clips would render with whatever was last saved, not
            what is on screen.
          </p>
        )}

        {/* Wordless on the way up too: what travels is the look, which is the
            only part of a title that can be the same on every project. */}
        <PromoteToDefaults
          build={() => ({ overlay_defaults: { ...current, text: '' } })}
          hint="New projects start drawing their titles this way. Projects that already exist keep their own look."
        />
      </Modal>
    </>
  );
};
