import React, { useState } from 'react';
import { Clip } from './Clip';
import type { JevScores } from '../../api';

interface ClipRaw {
  /** Position in the project's highlights, assigned where the list is built. */
  index: number;
  /** Where this clip already lives on YouTube, once it has been published. */
  youtubeUrl?: string | null;
  youtubeVideoId?: string | null;
  /** When it was last published, which is how a finished upload is judged. */
  uploadedAt?: string | null;
  /** The draft this clip is waiting as in Postiz, once it has been imported. */
  postizUrl?: string | null;
  /** When it was last imported, which is how a finished import is judged. */
  postizImportedAt?: string | null;
  /** What Postiz has done with it since: published, scheduled, error, or none. */
  postizState?: string | null;
  /** What Jev answered about this clip, or absent for a clip Gemini picked. */
  jevScores?: JevScores | null;
  original_start: number;
  original_end: number;
  text: string;
}

interface ClipManagerProps {
  projectId: string;
  clips: ClipRaw[];
  /**
   * Moments a Jev run scored below the project's cutoff. Kept out of the main
   * grid and behind a "show more" toggle, greyed, but still cards that can be
   * cut or published one at a time.
   */
  belowClips?: ClipRaw[];
  /** The uncut source, previewed inside each highlight's window. */
  sourceUrl: string | null;
  /** Target width / height the clipper would render at, or null for source. */
  aspectRatio: number | null;
  onDeleteClip: (index: number) => void;
}

const ClipGrid: React.FC<ClipManagerProps> = ({ projectId, clips, belowClips = [], sourceUrl, aspectRatio, onDeleteClip }) => {
  const [playingClipIndex, setPlayingClipIndex] = useState<number | null>(null);
  const [showBelow, setShowBelow] = useState(false);

  if (clips.length === 0 && belowClips.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-xl)',
        border: 'var(--border-width) dashed var(--border-color)',
        textAlign: 'center',
        backgroundColor: 'var(--bg)'
      }}>
        <h2 style={{ fontSize: '2rem', fontWeight: 900, margin: '0 0 var(--space-sm) 0', textTransform: 'uppercase' }}>
          No Clips Yet
        </h2>
        <p style={{ fontSize: '1.1rem', maxWidth: '500px', marginBottom: 'var(--space-lg)', lineHeight: '1.4' }}>
          Every clip appears here as a preview once the <strong>Highlights</strong> step has run — playable
          straight from the source, before anything is cut.
        </p>
        <div style={{
          padding: 'var(--space-sm) var(--space-md)',
          border: 'var(--border)',
          fontWeight: 900,
          fontSize: '1.2rem',
          // Three nudges, then still. Looping forever is motion that starts
          // automatically and never stops, which WCAG 2.2.2 asks for a pause
          // control for — and unlike the running-step sheen this conveys no
          // ongoing activity, so it earns no exemption. Three is enough to
          // point at the pipeline without becoming furniture that twitches.
          animation: 'nudge 2.4s var(--ease-out-quart) 3'
        }}>
          ↑ RUN PIPELINE ABOVE
        </div>
      </div>
    );
  }

  return (
    <div
      className="clip-manager"
      // The one place the target ratio reaches CSS. The grid track and the
      // per-card media cap both derive from it, so a portrait project gets
      // narrow tracks and a landscape one wide ones, and neither has to guess.
      // Left unset until the settings resolve, where the stylesheet's default
      // stands in.
      style={aspectRatio ? ({ ['--clip-ratio' as string]: String(aspectRatio) } as React.CSSProperties) : undefined}
    >
      {/* .card-grid rather than an inline copy of it: the class guards the
          track minimum with min(300px, 100%), which is what keeps the grid
          from overflowing viewports narrower than one card. */}
      <div className="card-grid">
        {clips.map((clip) => (
          <Clip
            // Keyed by the window it plays, not position: deleting a highlight
            // shifts every later index down, and an index key would hand clip
            // N+1 the mounted <video> (and its playback state) of the deleted one.
            // Not by filename: a render landing must not remount the card.
            key={`${clip.original_start}-${clip.original_end}`}
            projectId={projectId}
            // Passed straight through. Spreading a fresh object in here made a
            // new prop identity on every render and undid the memo on Clip.
            clip={clip}
            // Capped: past the first handful the stagger stops reading as
            // choreography and starts reading as the page being slow.
            enterDelayMs={Math.min(clip.index, 7) * 60}
            sourceUrl={sourceUrl}
            aspectRatio={aspectRatio}
            onDelete={onDeleteClip}
            playingClipIndex={playingClipIndex}
            setPlayingClipIndex={setPlayingClipIndex}
          />
        ))}
      </div>

      {belowClips.length > 0 && (
        <div style={{ marginTop: 'var(--space-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <button
            type="button"
            onClick={() => setShowBelow((open) => !open)}
            aria-expanded={showBelow}
            style={{
              alignSelf: 'flex-start',
              minHeight: '44px',
              padding: '0 var(--space-md)',
              border: 'var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              fontWeight: 900,
              fontSize: '0.8rem',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {showBelow ? 'Hide' : 'Show'} {belowClips.length} lower-scoring clips
          </button>
          {showBelow && (
            <div className="card-grid">
              {belowClips.map((clip) => (
                <div key={`${clip.original_start}-${clip.original_end}`} className="clip-below-cutoff">
                  <Clip
                    projectId={projectId}
                    clip={clip}
                    sourceUrl={sourceUrl}
                    aspectRatio={aspectRatio}
                    onDelete={onDeleteClip}
                    playingClipIndex={playingClipIndex}
                    setPlayingClipIndex={setPlayingClipIndex}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Memoised, like the cards inside it. Without this the grid re-ran on every
 * poll tick of a running step and rebuilt forty card elements for `React.memo`
 * to then throw away one by one — the memo on `Clip` was saving the render of
 * each card but not the work of offering it one.
 */
export const ClipManager = React.memo(ClipGrid);
