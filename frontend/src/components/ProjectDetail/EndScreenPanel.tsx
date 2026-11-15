import React, { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import {
  getEndScreenFileUrl,
  removeEndScreenFile,
  updateProjectSettings,
  uploadEndScreenFile,
  type EndScreenFileKind,
  type EndScreenSettings,
} from '../../api';

interface EndScreenPanelProps {
  projectId: string;
  /** What the project has stored, or undefined for a project created before this existed. */
  settings: EndScreenSettings | undefined;
  /** See CaptionStyler: `panel` is a row with a summary, `inline` is one text action. */
  variant?: 'panel' | 'inline';
}

const EMPTY: EndScreenSettings = { enabled: false, image: null, music: null, duration: 5 };

const ACCEPT: Record<EndScreenFileKind, string> = {
  image: '.png,.jpg,.jpeg,.webp',
  music: '.mp3,.m4a,.aac,.wav,.ogg',
};

/**
 * A picture held at the end of every clip in the project, with optional music
 * that plays only over it. Applied when a clip is cut, so clips already on
 * disk change the next time they are uploaded or regenerated.
 */
export const EndScreenPanel: React.FC<EndScreenPanelProps> = ({ projectId, settings, variant = 'panel' }) => {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const stored = settings ?? EMPTY;
  const [duration, setDuration] = useState(stored.duration);
  // The file keeps its name when replaced, so the preview needs its own key to
  // stop the browser showing the one it cached.
  const [version, setVersion] = useState(0);
  const enabledId = useId();
  const durationId = useId();
  const imageId = useId();
  const musicId = useId();

  // Read from the stored value each time the dialog opens, so a refresh in the
  // background never moves the slider under the user's hand.
  const open = () => {
    setDuration(stored.duration);
    setIsOpen(true);
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
  };

  const settingsMutation = useMutation({
    mutationFn: (next: Partial<Pick<EndScreenSettings, 'enabled' | 'duration'>>) =>
      updateProjectSettings(projectId, { end_screen: next }),
    onSuccess: refresh,
  });

  const fileMutation = useMutation({
    mutationFn: ({ kind, file }: { kind: EndScreenFileKind; file: File | null }) =>
      file ? uploadEndScreenFile(projectId, kind, file) : removeEndScreenFile(projectId, kind),
    onSuccess: () => {
      setVersion((v) => v + 1);
      refresh();
    },
  });

  const commitDuration = () => {
    if (duration !== stored.duration) settingsMutation.mutate({ duration });
  };

  const labelStyle: React.CSSProperties = {
    fontWeight: 900,
    fontSize: '0.65rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };
  const hintStyle: React.CSSProperties = { fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.3 };
  const columnStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' };

  const fileField = (kind: EndScreenFileKind, id: string, label: string, hint: string) => {
    const filename = stored[kind];
    const url = filename ? `${getEndScreenFileUrl(projectId, filename)}?v=${version}` : null;
    return (
      <div style={columnStyle}>
        <label htmlFor={id} style={labelStyle}>{label}</label>
        {url && kind === 'image' && (
          <img
            src={url}
            alt="End screen picture"
            style={{ maxWidth: '100%', maxHeight: '220px', objectFit: 'contain', alignSelf: 'flex-start', border: 'var(--border)' }}
          />
        )}
        {url && kind === 'music' && <audio src={url} controls style={{ width: '100%' }} />}
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            id={id}
            type="file"
            accept={ACCEPT[kind]}
            disabled={fileMutation.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) fileMutation.mutate({ kind, file });
              e.target.value = '';
            }}
          />
          {filename && (
            <button
              type="button"
              className="text-action"
              disabled={fileMutation.isPending}
              onClick={() => fileMutation.mutate({ kind, file: null })}
            >
              Remove
            </button>
          )}
        </div>
        <span style={hintStyle}>{hint}</span>
      </div>
    );
  };

  const error = settingsMutation.error ?? fileMutation.error;
  const active = stored.enabled && !!stored.image;
  const badge = (
    <span
      className="status-badge"
      style={active ? { background: 'var(--success)', color: 'var(--on-success)' } : undefined}
    >
      {active ? `${stored.duration}s` : 'Off'}
    </span>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button type="button" className="text-action" onClick={open}>
          End screen
          {badge}
        </button>
      ) : (
        <button type="button" className="panel-button" onClick={open}>
          <span>End screen</span>
          {badge}
        </button>
      )}

      <Modal isOpen={isOpen} title="End screen" onClose={() => setIsOpen(false)} maxWidth="620px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <label htmlFor={enabledId} style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
            <input
              id={enabledId}
              type="checkbox"
              checked={stored.enabled}
              onChange={(e) => settingsMutation.mutate({ enabled: e.target.checked })}
            />
            Add an end screen to every clip
          </label>
          {stored.enabled && !stored.image && (
            <p role="status" style={{ ...hintStyle, margin: 0, color: 'var(--warning-text)' }}>
              No picture yet, so clips are cut without an end screen.
            </p>
          )}

          {fileField(
            'image',
            imageId,
            'Picture',
            'Fitted inside the clip frame on black, never cropped. Design it at the clip aspect ratio to fill the frame.'
          )}
          {fileField(
            'music',
            musicId,
            'Music (optional)',
            'Plays only over the end screen, cut to its length and faded out. Without music the end screen is silent.'
          )}

          <div style={columnStyle}>
            <label htmlFor={durationId} style={labelStyle}>Duration: {duration}s</label>
            <input
              id={durationId}
              type="range"
              min={1}
              max={20}
              step={0.5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              onPointerUp={commitDuration}
              onKeyUp={commitDuration}
              onBlur={commitDuration}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
            <span style={hintStyle}>
              Added after the clip, so a short near the platform length limit can go over it.
            </span>
          </div>

          <p style={{ ...hintStyle, margin: 0 }}>
            Applied when a clip is cut. Clips already cut change the next time they are uploaded, sent to Postiz or regenerated.
          </p>
        </div>

        {error && (
          <p role="alert" style={{ margin: 'var(--space-md) 0 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            {error.message || 'Could not save that. Please try again.'}
          </p>
        )}
      </Modal>
    </>
  );
};
