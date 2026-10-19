import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { ClipPlayer } from './ClipPlayer';
import { updateClipTrim } from '../../api';
import { formatTimecode } from '../../utils/aspectRatio';

/** The shortest window the backend will store. Refused there too. */
export const MIN_CLIP_DURATION = 0.5;

/**
 * How far each nudge moves an edge.
 *
 * A second is the unit the problem is actually stated in — "it starts a couple
 * of seconds early" — and a tenth is what closes the gap once the second has
 * been spent. Marking from the playhead covers everything in between.
 */
const STEPS = [1, 0.1];

/**
 * How far outside the clip the player may be asked to reach.
 *
 * Marking an edge from the playhead only moves it inwards while the player is
 * held to the clip's own window: there is nothing before the in point to scrub
 * to. Handles put a few seconds of the surrounding footage either side, so the
 * same one click also moves an edge outwards.
 */
const HANDLE_SECONDS = 5;

/**
 * How much of the tail the picture parks on after the out point is moved.
 *
 * Moving the end is a question about the last moment of the clip, so the player
 * jumps to just before it rather than replaying from the top.
 */
const TAIL_PREVIEW_SECONDS = 2;

interface ClipTrimmerProps {
  projectId: string;
  clipIndex: number;
  isOpen: boolean;
  onClose: () => void;
  /** The window as stored, in seconds into the source. */
  start: number;
  end: number;
  /** The uncut source this window is cut from, or null when there is none. */
  sourceUrl: string | null;
  /** Target width / height the clipper would render at, or null for source. */
  aspectRatio: number | null;
  label: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Where one clip starts and ends, marked off the playhead or nudged a step at
 * a time.
 *
 * The model picks the window from the word map, which puts the edges on word
 * boundaries — and a word boundary is not a shot boundary. A clip that opens on
 * half a breath or runs a beat past the punchline is off by a second or two, and
 * that second is the difference between a short somebody watches and one they
 * scroll past. Re-running the highlights step to fix it would throw away every
 * other clip in the project.
 *
 * The edit is made by watching, so the picture is the whole left pane and every
 * control sits beside it: scrub to the frame the clip should open or close on
 * and mark it, in one press. Handles put a few seconds of the surrounding
 * footage either side of the window, which is what lets that same press move an
 * edge outwards as well as in; without them there is nothing before the in point
 * to scrub to. The nudge buttons remain for an adjustment smaller than a scrub
 * can aim at, and the number fields for anyone who has an exact timecode.
 *
 * Both edges are bounded: `start` cannot go below zero, `end` cannot pass the
 * end of the source — which only the media element knows, so it reports it —
 * and the two cannot close past `MIN_CLIP_DURATION`.
 *
 * Saving moves the highlight and nothing else. The cut file, if there is one,
 * still holds the window from before the edit until the next upload or import
 * cuts the clip again.
 */
export const ClipTrimmer: React.FC<ClipTrimmerProps> = ({
  projectId,
  clipIndex,
  isOpen,
  onClose,
  start,
  end,
  sourceUrl,
  aspectRatio,
  label,
}) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ start, end });
  // Reported by the player, because the media element is the only thing here
  // that knows how long the source runs. Zero until it has read the metadata,
  // which reads as "no far edge known yet" rather than "the source is empty".
  const [sourceDuration, setSourceDuration] = useState(0);
  // Which edge was last moved, and so which one the picture should be sitting
  // on: adjusting the out point and being shown the in point answers nothing.
  const [watching, setWatching] = useState<'start' | 'end'>('start');
  // Whether the player may run into the footage either side of the clip. Off by
  // default, so what plays is exactly what would be cut.
  const [handles, setHandles] = useState(false);
  // Where the playhead is inside whatever the player is playing, in seconds
  // from the top of that window rather than from the top of the source.
  const [playhead, setPlayhead] = useState(0);
  const startRef = useRef<HTMLInputElement>(null);

  // Opening is a fresh session: the draft is whatever is stored, and the
  // picture starts on the in point, which is where a trim is usually judged.
  useEffect(() => {
    if (!isOpen) return;
    setDraft({ start, end });
    setWatching('start');
    setHandles(false);
    // Only on open. Following `start`/`end` here would put the picture back on
    // the in point every time a save landed, including a save of the out point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // The stored window moving under the dialog — which is what a save landing
  // looks like — takes the draft with it. Without this the values just written
  // would keep reading as an unsaved edit.
  useEffect(() => {
    setDraft({ start, end });
  }, [start, end]);

  const mutation = useMutation({
    mutationFn: (next: { start: number; end: number }) =>
      updateClipTrim(projectId, clipIndex, next),
    onSuccess: () => {
      // The window travels on the project, and it decides which words fall
      // inside the clip — so the cues.
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projectMetadata', projectId] });
      queryClient.invalidateQueries({ queryKey: ['clipCaptions', projectId] });
    },
  });

  const duration = Math.max(0, draft.end - draft.start);
  const isDirty = round(draft.start) !== round(start) || round(draft.end) !== round(end);
  // The end of the source, once it is known. Until then the far edge is
  // unbounded here and the file itself bounds it when ffmpeg cuts.
  const farEdge = sourceDuration > 0 ? sourceDuration : Number.POSITIVE_INFINITY;

  // What the player is actually playing: the clip, or the clip with a few
  // seconds of its surroundings, never past either end of the source.
  const pad = handles ? HANDLE_SECONDS : 0;
  const playStart = Math.max(0, draft.start - pad);
  const playEnd = Math.min(farEdge, draft.end + pad);
  // The playhead in the source's own timeline, which is the number both mark
  // buttons write and the one an editor elsewhere would recognise.
  const playheadAt = playStart + playhead;

  const moveStart = (seconds: number) => {
    setWatching('start');
    setDraft((current) => ({
      ...current,
      start: round(Math.min(Math.max(0, seconds), current.end - MIN_CLIP_DURATION)),
    }));
  };

  const moveEnd = (seconds: number) => {
    setWatching('end');
    setDraft((current) => ({
      ...current,
      end: round(Math.max(Math.min(seconds, farEdge), current.start + MIN_CLIP_DURATION)),
    }));
  };

  // Memoised because the player reports the playhead from an effect keyed on
  // this identity: a fresh function every render would re-run it every render.
  const reportPlayhead = useCallback((position: number) => setPlayhead(position), []);

  // Marking is refused rather than silently clamped when the playhead is on the
  // wrong side of the other edge: a button that moves the edge somewhere the
  // user can plainly see they did not point at is worse than one that waits.
  const canMarkStart = playheadAt <= draft.end - MIN_CLIP_DURATION;
  const canMarkEnd = playheadAt >= draft.start + MIN_CLIP_DURATION;

  /** Whether the window actually reached the backend. */
  const save = async () => {
    try {
      await mutation.mutateAsync({ start: draft.start, end: draft.end });
      return true;
    } catch {
      // Swallowed here and read off the mutation below: an unhandled rejection
      // is a console error nobody sees, and the sentence the user needs is
      // already on screen.
      return false;
    }
  };

  const edge = (
    kind: 'start' | 'end',
    value: number,
    move: (seconds: number) => void
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <label
        htmlFor={`clip-${clipIndex}-trim-${kind}`}
        style={{ fontSize: '0.75rem', fontWeight: 900, textTransform: 'uppercase' }}
      >
        {kind === 'start' ? 'Starts at' : 'Ends at'}{' '}
        <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {formatTimecode(value)}
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        {STEPS.map((step) => (
          <Button
            key={`-${step}`}
            variant="ghost"
            size="sm"
            onClick={() => move(value - step)}
            aria-label={`Move the ${kind} of the clip ${step} seconds earlier`}
            style={{ minWidth: '44px', minHeight: '44px', fontVariantNumeric: 'tabular-nums' }}
          >
            −{step}s
          </Button>
        ))}
        <input
          id={`clip-${clipIndex}-trim-${kind}`}
          ref={kind === 'start' ? startRef : undefined}
          type="number"
          step={0.1}
          min={0}
          value={value}
          // Seconds into the source, which is what the timecode beside the
          // label says in a form anybody can find in an editor.
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) move(next);
          }}
          style={{
            width: '7ch',
            minHeight: '44px',
            padding: 'var(--space-sm)',
            border: 'var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontWeight: 900,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        {[...STEPS].reverse().map((step) => (
          <Button
            key={`+${step}`}
            variant="ghost"
            size="sm"
            onClick={() => move(value + step)}
            aria-label={`Move the ${kind} of the clip ${step} seconds later`}
            style={{ minWidth: '44px', minHeight: '44px', fontVariantNumeric: 'tabular-nums' }}
          >
            +{step}s
          </Button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      title={`Trim clip ${clipIndex + 1}`}
      onClose={onClose}
      // Far wider than the app's other clip dialogs, and deliberately: this one
      // is a picture with controls beside it, not a form with a preview on top.
      maxWidth="min(1100px, 95vw)"
      initialFocusRef={startRef}
      footer={
        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={!isDirty || mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : 'Save trim'}
          </Button>
          {isDirty && (
            <Button variant="ghost" onClick={() => setDraft({ start, end })}>
              Reset
            </Button>
          )}
        </div>
      }
    >
      <div
        className="trim-layout"
        // The one place the clip's ratio reaches CSS here, the same variable
        // the grid sets: it is what caps a portrait clip by height instead of
        // letting it run past the bottom of the dialog.
        style={
          aspectRatio
            ? ({ ['--clip-ratio' as string]: String(aspectRatio) } as React.CSSProperties)
            : undefined
        }
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {sourceUrl ? (
            <>
              <div className="trim-video">
                <ClipPlayer
                  src={sourceUrl}
                  start={playStart}
                  end={playEnd}
                  isPreview
                  aspectRatio={aspectRatio}
                  label={label}
                  // Parks on the edge last moved. The player re-seeks whenever
                  // this changes, which is what makes a nudge visible.
                  initialOffset={
                    watching === 'start'
                      ? draft.start - playStart
                      : Math.max(0, draft.end - playStart - TAIL_PREVIEW_SECONDS)
                  }
                  onPositionChange={reportPlayhead}
                  onSourceDuration={setSourceDuration}
                />
              </div>

              {/* Under the picture rather than in the column beside it: these
                  two act on where the playhead is, so they belong within reach
                  of the transport that moves it. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 900,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatTimecode(playheadAt)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => moveStart(round(playheadAt))}
                  disabled={!canMarkStart}
                  aria-label="Start the clip at the frame the player is on"
                  style={{ minHeight: '44px', flex: '1 1 auto' }}
                >
                  ⤒ Start here
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => moveEnd(round(playheadAt))}
                  disabled={!canMarkEnd}
                  aria-label="End the clip at the frame the player is on"
                  style={{ minHeight: '44px', flex: '1 1 auto' }}
                >
                  ⤓ End here
                </Button>
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={handles}
                  onChange={(event) => setHandles(event.target.checked)}
                  style={{ width: '18px', height: '18px', accentColor: 'var(--accent)' }}
                />
                Play {HANDLE_SECONDS}s either side, to mark an edge outside the clip
              </label>
            </>
          ) : (
            <p
              role="status"
              style={{
                margin: 0,
                padding: 'var(--space-md)',
                border: 'var(--border-width) dashed var(--border-color)',
                textAlign: 'center',
                fontSize: '0.75rem',
              }}
            >
              The source video is gone from this project, so the trim cannot be watched.
              The numbers beside this still apply to the next render.
            </p>
          )}
        </div>

        <div
          style={{
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-md)',
          }}
        >
          {edge('start', draft.start, moveStart)}
          {edge('end', draft.end, moveEnd)}

          <p
            role="status"
            style={{
              margin: 0,
              fontSize: '0.8rem',
              fontWeight: 900,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatTimecode(draft.start)}–{formatTimecode(draft.end)} · {duration.toFixed(1)}s long
          </p>

          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            The captions follow the window: words that fall outside it stop appearing.
          </p>

          {mutation.isError && (
            <p role="alert" style={{ margin: 0, fontSize: '0.75rem', color: 'var(--error)' }}>
              {(mutation.error as Error)?.message ?? 'The trim could not be saved.'}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
};
