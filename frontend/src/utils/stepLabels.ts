/**
 * What each pipeline step is called in the interface.
 *
 * The backend names steps after the code that runs them: `metadata` is the
 * shape of a payload. That says nothing about what the user gets out of it,
 * and is actively misleading — that step writes ten titles and a social post
 * for each one.
 *
 * Steps are named here after their output, so the row reads as a list of
 * things you end up with rather than a list of programs that ran. A step added
 * purely as a prompt file has no entry and falls back to its own name, which
 * is what keeps a new prompt usable with no code change.
 */
const STEP_LABELS: Record<string, string> = {
  transcription: 'Transcript',
  highlights: 'Highlights',
  metadata: 'Titles & Posts',
  upload: 'Upload',
  // Named for where the clips end up rather than for what the step does to
  // them: 'Import' alone reads as bringing something in, which is backwards.
  postiz: 'Postiz Drafts',
};

const titleCase = (name: string) =>
  name.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export const stepLabel = (name: string): string => STEP_LABELS[name] ?? titleCase(name);
