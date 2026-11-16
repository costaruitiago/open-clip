import React, { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { DescriptionFieldHelp } from '../DescriptionFieldHelp';
import { PromoteToDefaults } from '../PromoteToDefaults';
import { updateProjectSettings, type DescriptionSettings } from '../../api';

interface DescriptionPanelProps {
  projectId: string;
  /** What the project has stored, or undefined for a project created before this existed. */
  settings: DescriptionSettings | undefined;
  /** See CaptionStyler: `panel` is a row with a summary, `inline` is one text action. */
  variant?: 'panel' | 'inline';
}

const EMPTY: DescriptionSettings = { source_url: '', source_title: '', text: '', template: '' };

/**
 * The project's half of the YouTube description, behind a button.
 *
 * The original video is a project fact — every short cut from it points back at
 * the same episode — and the link is what YouTube uses to connect a short to the
 * video it came from, so it is asked for here rather than left to the model.
 *
 * Fields are written when the user leaves them rather than on every keystroke:
 * these are sentences and URLs typed once, not sliders dragged.
 */
export const DescriptionPanel: React.FC<DescriptionPanelProps> = ({ projectId, settings, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<DescriptionSettings>(settings ?? EMPTY);
  const urlId = useId();
  const titleId = useId();
  const textId = useId();
  const templateId = useId();

  // A background metadata refresh must not overwrite what the user is typing,
  // so the draft only re-syncs while the dialog is closed.
  useEffect(() => {
    if (!isOpen) setDraft(settings ?? EMPTY);
  }, [settings, isOpen]);

  const mutation = useMutation({
    mutationFn: (next: Partial<DescriptionSettings>) =>
      updateProjectSettings(projectId, { description: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      // Every clip's description is built from these, so the previews are stale.
      queryClient.invalidateQueries({ queryKey: ['clipDescription', projectId] });
    },
  });

  const stored = settings ?? EMPTY;

  const commit = (field: keyof DescriptionSettings) => {
    if (draft[field] === stored[field]) return;
    mutation.mutate({ [field]: draft[field] });
  };

  const fieldStyle: React.CSSProperties = {
    padding: 'var(--space-sm)',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: 'var(--border)', borderRadius: 'var(--radius-lg)',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    width: '100%',
  };

  const labelStyle: React.CSSProperties = {
    fontWeight: 500,
    fontSize: '0.75rem',
  };

  const field = (
    id: string,
    label: string,
    name: keyof DescriptionSettings,
    hint: string,
    multiline = false
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      {multiline ? (
        <textarea
          id={id}
          value={draft[name]}
          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
          onBlur={() => commit(name)}
          style={{ ...fieldStyle, minHeight: '110px', fontFamily: 'monospace', lineHeight: 1.4 }}
        />
      ) : (
        <input
          id={id}
          type="text"
          spellCheck={false}
          value={draft[name]}
          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })}
          onBlur={() => commit(name)}
          style={fieldStyle}
        />
      )}
      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>{hint}</span>
    </div>
  );

  const badge = (
    <span
      className="status-badge"
      style={stored.source_url ? { background: 'var(--success)', color: 'var(--on-success)' } : undefined}
    >
      {stored.source_url ? 'Linked' : 'No source'}
    </span>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={() => setIsOpen(true)}>
          Description
          {badge}
        </button>
      ) : (
        <>
          <button type="button" className="panel-button" onClick={() => setIsOpen(true)}>
            <span>Description</span>
            {badge}
          </button>
          <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {stored.source_url
              ? `Shorts link back to ${stored.source_title || 'the original video'}`
              : 'Add the original video so every short can point back to it'}
          </p>
        </>
      )}

      <Modal isOpen={isOpen} title="YouTube description" onClose={() => setIsOpen(false)} maxWidth="620px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          {field(
            urlId,
            'Original video URL',
            'source_url',
            'The full episode this project was cut from. It goes in every description as a link back. YouTube\'s own "Related video" chip is separate and can only be set per short in Studio.'
          )}
          {field(
            titleId,
            'Original video title',
            'source_title',
            'How the episode is named in the description, e.g. "The Podcast — Episode 12".'
          )}
          {field(
            textId,
            'Project text',
            'text',
            'Text added to every description in this project. Use {project.text} in the template to place it.',
            true
          )}
          {field(
            templateId,
            'Template for this project',
            'template',
            'Leave empty to use the template from Settings. Anything you type here is used exactly as written, except fields in braces.',
            true
          )}
          <DescriptionFieldHelp />
        </div>

        {mutation.isError && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            Could not save that. Uploads would use the last saved description, not this one.
          </p>
        )}

        {/* Only the two fields that could belong to any project. The URL and
            the title name one episode, and promoting them would put this
            project's source link under every other project's shorts.

            Built from the draft rather than from what is stored: leaving a box
            saves it, but the metadata has not come back by the time the click
            lands, and promoting the previous text is the one mistake this
            control cannot let the user make quietly. */}
        <PromoteToDefaults
          build={(app) => {
            if (!draft.text && !draft.template) return {};
            return {
              description_defaults: {
                ...(app.description_defaults ?? {}),
                ...(draft.text ? { text: draft.text } : {}),
                ...(draft.template ? { template: draft.template } : {}),
              },
            };
          }}
          hint="The project text and template become the ones every project uses. These are read when a clip is uploaded, so existing projects change too — except any that wrote their own. The link back to the original video stays here."
          emptyHint="Only the project text and the template can belong to every project, and this project has neither. The URL and title name one episode."
        />
      </Modal>
    </>
  );
};
