import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JevScoreBadge, JevTags } from './JevScoreBadge';

describe('JevScoreBadge', () => {
  it('shows the score relative to the video, with the weighted score behind it', () => {
    render(
      <JevScoreBadge
        scores={{ hook: 0.6, attention: 0.8, standalone: 0.3, score: 0.65, relative: 1, loop: null, loop_used: false }}
      />
    );

    // The corner and the "in this video" row both read 100; the weighted row 65.
    expect(screen.getAllByText('100')).toHaveLength(2);
    expect(screen.getByText('65')).toBeDefined();
    expect(screen.getByText('×50%')).toBeDefined();
    expect(screen.getByText('×40%')).toBeDefined();
    expect(screen.getByText('×10%')).toBeDefined();
  });

  it('keeps the loop out of the score rows', () => {
    render(<JevScoreBadge scores={{ hook: 0.6, attention: 0.6, standalone: 0.6, score: 0.6, relative: 0.5, loop: 0.9, loop_used: true }} />);

    expect(screen.getByText('Ends on a loop')).toBeDefined();
    expect(screen.queryByText('90')).toBeNull();
  });
});

describe('JevTags', () => {
  it('names each quality the clip is outstanding at', () => {
    render(<JevTags tags={['great_hook', 'attention_grabber']} />);

    expect(screen.getByText('Great hook')).toBeDefined();
    expect(screen.getByText('Attention grabber')).toBeDefined();
  });
});
