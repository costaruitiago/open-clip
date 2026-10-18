import { describe, expect, it } from 'vitest';
import type { Highlight } from '../api';
import { effectiveJevCutoff, selectedIndices } from './jevSelection';

const scored = (...scores: (number | null)[]): Highlight[] =>
  scores.map((score, i) => ({ start: i * 10, end: i * 10 + 5, jev_scores: score === null ? null : { score } }));

describe('selectedIndices', () => {
  it('keeps the moments at or above the cutoff', () => {
    expect(selectedIndices(scored(0.6, 0.2, 0.5, 0.1), 0.5)).toEqual(new Set([0, 2]));
  });

  it('never adds a clip below the cutoff, however few pass', () => {
    expect(selectedIndices(scored(0.49, 0.37), 0.5)).toEqual(new Set());
  });

  it('judges a score by the number the card shows', () => {
    // 0.497 is drawn as 50, so it is a clip at a cutoff of 50.
    expect(selectedIndices(scored(0.497, 0.494), 0.5)).toEqual(new Set([0]));
  });

  it('compares the score relative to the video when there is one', () => {
    const highlights: Highlight[] = [
      { start: 0, end: 5, jev_scores: { score: 0.4, relative: 1 } },
      { start: 10, end: 15, jev_scores: { score: 0.45, relative: 0.2 } },
    ];
    expect(selectedIndices(highlights, 0.5)).toEqual(new Set([0]));
  });

  it('treats every highlight without a Jev score as a clip', () => {
    expect(selectedIndices(scored(null, null), 0.9)).toEqual(new Set([0, 1]));
  });
});

describe('effectiveJevCutoff', () => {
  it('prefers the project, then the application, then zero', () => {
    expect(effectiveJevCutoff(0.4, 0.2)).toBe(0.4);
    expect(effectiveJevCutoff(null, 0.2)).toBe(0.2);
    expect(effectiveJevCutoff(undefined, undefined)).toBe(0);
  });
});
