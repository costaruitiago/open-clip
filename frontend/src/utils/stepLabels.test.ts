import { describe, it, expect } from 'vitest';
import { stepLabel } from './stepLabels';

describe('stepLabel', () => {
  it('names steps after what they produce, not the code that runs them', () => {
    expect(stepLabel('postiz')).toBe('Postiz Drafts');
    // This step writes ten titles and a social post for each; "Metadata"
    // described the payload shape, not the output.
    expect(stepLabel('metadata')).toBe('Titles & Posts');
    expect(stepLabel('transcription')).toBe('Transcript');
  });

  // A step can be added with nothing but a prompt file and an entry in
  // pipeline.json, so an unknown name has to stay presentable.
  it('falls back to the step name for prompt-defined steps', () => {
    expect(stepLabel('chapters')).toBe('Chapters');
    expect(stepLabel('key_moments')).toBe('Key Moments');
  });
});
