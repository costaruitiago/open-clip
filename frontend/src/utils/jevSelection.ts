import type { Highlight, JevScores } from '../api';

/**
 * The score a card shows and the cutoff is compared against: relative to the
 * video, or the raw score for a clip scored before relative scores existed.
 * Mirrors `jev_display_score` in backend/src/services/highlight_options.py.
 */
export const displayScore = (scores: JevScores | null | undefined): number | undefined =>
  typeof scores?.relative === 'number' ? scores.relative : scores?.score;

/**
 * Which highlights are this project's clips, by position.
 *
 * Mirrors `selected_indices` in backend/src/services/highlight_options.py,
 * which decides what the cut and publish steps work through. A Jev
 * run keeps every moment it scored; the ones at or above the cutoff are the
 * clips, and only those. A highlight without a Jev score (every Gemini one) is
 * always a clip.
 */
export const selectedIndices = (highlights: Highlight[], cutoff: number): Set<number> => {
  // Compared as the 0–100 whole numbers the page shows, so a clip labelled 50
  // is never on the wrong side of a cutoff of 50.
  const minimum = toScore(cutoff);
  const chosen = new Set<number>();
  highlights.forEach((h, index) => {
    const score = displayScore(h.jev_scores);
    if (typeof score !== 'number' || toScore(score) >= minimum) chosen.add(index);
  });
  return chosen;
};

/** What each tag the backend gives a clip reads as on its card. */
export const TAG_LABELS: Record<string, string> = {
  great_hook: 'Great hook',
  attention_grabber: 'Attention grabber',
  stands_alone: 'Stands alone',
};

/** A 0–1 score as the 0–100 number the page shows. */
export const toScore = (value: number): number => Math.round(value * 100);

/** The project's own cutoff, then the application's, then 0. */
export const effectiveJevCutoff = (
  project: number | null | undefined,
  app: number | null | undefined
): number => {
  if (typeof project === 'number') return project;
  if (typeof app === 'number') return app;
  return 0;
};
