import React, { useId } from 'react';
import type { JevScores } from '../../api';
import { TAG_LABELS, displayScore, toScore } from '../../utils/jevSelection';

const show = (value: number | null | undefined): string =>
  typeof value === 'number' ? String(toScore(value)) : '—';

/** Each answer's name on the card and its share of the score, in display order. */
const ANSWERS: { key: 'hook' | 'attention' | 'standalone'; label: string; weight: number }[] = [
  { key: 'hook', label: 'Hooks in the first seconds', weight: 50 },
  { key: 'attention', label: 'Grabs attention', weight: 40 },
  { key: 'standalone', label: 'Stands alone', weight: 10 },
];

/** The qualities this clip is outstanding at (a raw answer of 80 or more), as chips. */
export const JevTags: React.FC<{ tags: string[] }> = ({ tags }) => (
  <span className="jev-tags">
    {tags.map((tag) => (
      <span key={tag} className="jev-tag">{TAG_LABELS[tag] ?? tag}</span>
    ))}
  </span>
);

/**
 * The clip's score in the card's corner — relative to this video, so its best
 * clip is 100 — with what it is made of on hover or keyboard focus: each
 * answer and its weight, the weighted score they give, and where that puts the
 * clip in this video. Focusable because a breakdown only a mouse can open is
 * one keyboard and touch users never see.
 */
export const JevScoreBadge: React.FC<{ scores: JevScores }> = ({ scores }) => {
  const detailId = useId();
  const loopKnown = typeof scores.loop === 'number';
  const isRelative = typeof scores.relative === 'number';

  return (
    <span className="jev-score" tabIndex={0} aria-describedby={detailId}>
      <span className="jev-score__value">{show(displayScore(scores))}</span>
      <span id={detailId} role="tooltip" className="jev-score__detail">
        {ANSWERS.filter((a) => typeof scores[a.key] === 'number').map((a) => (
          <span key={a.key} className="jev-score__row">
            <span>{a.label} <span style={{ opacity: 0.6 }}>×{a.weight}%</span></span>
            <strong>{show(scores[a.key])}</strong>
          </span>
        ))}
        <span className="jev-score__row jev-score__total">
          <span>Weighted</span>
          <strong>{show(scores.score)}</strong>
        </span>
        {isRelative && (
          <span className="jev-score__row">
            <span>In this video (best = 100)</span>
            <strong>{show(scores.relative)}</strong>
          </span>
        )}
        {/* Not part of the score: whether the clip ends on a word that runs
            back into its opening, which is where it was cut. */}
        <span className="jev-score__row">
          <span>Ends on a loop</span>
          <strong>{loopKnown ? (scores.loop_used ? 'yes' : 'no') : 'checking…'}</strong>
        </span>
      </span>
    </span>
  );
};
