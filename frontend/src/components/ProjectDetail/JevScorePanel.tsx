import React, { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateProjectSettings } from '../../api';
import { useDebounce } from '../../hooks/useDebounce';
import { toScore } from '../../utils/jevSelection';

interface JevScorePanelProps {
  projectId: string;
  /** The minimum in force (0–1): the project's own, else the Settings one. */
  cutoff: number;
  /** Whether the project has its own minimum rather than following Settings. */
  hasOwnCutoff: boolean;
  clipCount: number;
  total: number;
}

/**
 * The minimum score for one project, inside the header's clips menu. Every
 * clip is already scored, so moving it only re-sorts the page; the cut and
 * upload steps then work through the clips at or above it.
 */
export const JevScorePanel: React.FC<JevScorePanelProps> = ({ projectId, cutoff, hasOwnCutoff, clipCount, total }) => {
  const sliderId = useId();
  const helpId = useId();
  const queryClient = useQueryClient();
  // Shown while dragging, saved once it settles: one write per drag. The
  // parent keys this by the saved value, so a new saved value starts afresh.
  const [draft, setDraft] = useState(toScore(cutoff));
  const settled = useDebounce(draft, 400);

  const { mutate } = useMutation({
    mutationFn: (value: number | null) => updateProjectSettings(projectId, { highlights: { jev_min_score: value } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
    },
  });

  useEffect(() => {
    if (settled !== toScore(cutoff)) mutate(settled / 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saving reacts to the settled draft only
  }, [settled]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', minWidth: '260px' }}>
      <label htmlFor={sliderId} style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: '0.8rem', textTransform: 'uppercase' }}>
        <span>Minimum score</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{draft}</span>
      </label>
      <input
        id={sliderId}
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        aria-describedby={helpId}
        style={{ width: '100%', minHeight: '44px', accentColor: 'var(--accent)' }}
      />
      <span id={helpId} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
        {clipCount} of {total} clips. The rest move under “lower-scoring clips” and are skipped when
        cutting or uploading all clips.
      </span>
      {hasOwnCutoff && (
        <button
          type="button"
          onClick={() => mutate(null)}
          style={{ alignSelf: 'flex-start', minHeight: '44px', padding: 0, border: 'none', background: 'none', color: 'var(--text)', textDecoration: 'underline', fontSize: '0.75rem', cursor: 'pointer' }}
        >
          Use the default from Settings
        </button>
      )}
    </div>
  );
};
