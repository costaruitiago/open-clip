import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PipelineActivity, PipelineController } from './PipelineController';
import type { PipelineStep } from './PipelineController';

const steps: PipelineStep[] = [
  { name: 'transcription', label: 'Transcription', status: 'completed' },
  { name: 'highlights', label: 'Highlights', status: 'completed', isLlm: true },
  { name: 'chapters', label: 'Chapters', status: 'error', isLlm: true },
  { name: 'clipper', label: 'Clipper', status: 'todo' },
];

const renderController = (onExecute = vi.fn()) => {
  render(<PipelineController onExecute={onExecute} steps={steps} />);
  return onExecute;
};

describe('PipelineController', () => {
  // Compact is not "the same two blocks with smaller buttons".
  // --------------------------------------------------------------------------
  // It was, and that was the bug: a full-width run bar on a row of its own,
  // then a grid whose 140px minimum track wrapped four steps onto two or three
  // rows — and onto one row each below 600px, where the grid collapses to a
  // single column. The pipeline held half the page against the clip grid it
  // exists to fill.
  describe('compact', () => {
    const renderCompact = () =>
      render(<PipelineController onExecute={vi.fn()} steps={steps} prominence="compact" />);

    it('puts the whole pipeline in one strip, run button included', () => {
      const { container } = renderCompact();

      const strip = container.querySelector('.pipeline-strip');
      expect(strip).not.toBeNull();
      // The grid is gone, not merely restyled.
      expect(container.querySelector('.pipeline-steps')).toBeNull();
      // And the run button is inside the strip rather than on a row above it.
      const runAll = screen.getByRole('button', { name: /Run full pipeline/i });
      expect(runAll.parentElement).toBe(strip);
      expect(runAll.style.width).toBe('auto');
    });

    it('sizes every item in the strip the same, the AI menu included', () => {
      renderCompact();

      // This trigger is built by a different component and was reading the
      // default prominence, so it stood 60px tall in a row of 44px buttons.
      const aiSteps = screen.getByRole('button', { name: /AI Steps/i });
      const step = screen.getByRole('button', { name: /Clipper/i });

      expect(aiSteps.style.minHeight).toBe('44px');
      expect(step.style.minHeight).toBe('44px');
      // Strip items are as wide as their label; grid cells stretch.
      expect(aiSteps.style.width).toBe('auto');
      expect(step.style.width).toBe('auto');
      // One line: the status reads beside the step name, not under it.
      expect(step.style.flexDirection).toBe('row');
    });

    it('leaves the grid alone when the pipeline leads', () => {
      const { container } = render(<PipelineController onExecute={vi.fn()} steps={steps} />);

      expect(container.querySelector('.pipeline-steps')).not.toBeNull();
      expect(container.querySelector('.pipeline-strip')).toBeNull();
      expect(screen.getByRole('button', { name: /Clipper/i }).style.minHeight).toBe('60px');
    });
  });

  it('collapses every LLM step into a single button', () => {
    renderController();

    expect(screen.getByRole('button', { name: /AI Steps/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Highlights$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Chapters$/i })).toBeNull();
  });

  it('previews the queries and their status on hover', () => {
    renderController();
    const trigger = screen.getByRole('button', { name: /AI Steps/i });

    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerEnter(trigger.parentElement!, { pointerType: 'mouse' });

    const menu = screen.getByRole('menu');
    expect(menu.textContent).toContain('Highlights');
    // The rows carry the same human labels as the step buttons, not the raw
    // status strings from the API.
    expect(menu.textContent).toContain('done');
    expect(menu.textContent).toContain('failed');
  });

  it('ignores hover from a touch pointer, which never sends the matching leave', () => {
    renderController();
    const trigger = screen.getByRole('button', { name: /AI Steps/i });

    fireEvent.pointerEnter(trigger.parentElement!, { pointerType: 'touch' });

    // A tap opens the menu through the click handler instead, so opening here
    // as well would leave it latched open with no way to dismiss it by hand.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the dropdown open once pressed so its rows can be clicked', () => {
    const onExecute = renderController();
    const trigger = screen.getByRole('button', { name: /AI Steps/i });

    fireEvent.click(trigger);
    // Pointer leaves the button on the way to a row; the pinned menu must survive it.
    fireEvent.pointerLeave(trigger.parentElement!, { pointerType: 'mouse' });

    fireEvent.click(screen.getByRole('menuitem', { name: /Chapters/i }));
    expect(onExecute).toHaveBeenCalledWith('START', 'chapters');
  });

  describe('completion flourish', () => {
    const allDone: PipelineStep[] = steps.map((step) => ({ ...step, status: 'completed' }));

    it('stays silent for a pipeline that was already finished on arrival', () => {
      render(<PipelineController onExecute={vi.fn()} steps={allDone} />);
      expect(document.querySelector('.sweep-clip')).toBeNull();
    });

    it('sweeps when the last step completes while the page is open', () => {
      const { rerender } = render(<PipelineController onExecute={vi.fn()} steps={steps} />);
      expect(document.querySelector('.sweep-clip')).toBeNull();

      rerender(<PipelineController onExecute={vi.fn()} steps={allDone} />);
      expect(document.querySelector('.sweep-clip')).not.toBeNull();
    });
  });

  it('surfaces a failed query on the collapsed button', () => {
    renderController();

    // `chapters` errored, so the aggregate must not read as completed.
    expect(screen.getByRole('button', { name: /AI Steps/i }).style.color).toBe('var(--error)');
  });

  // A step that filed one draft out of twenty used to paint itself green and
  // say "done", which is how someone goes looking for nineteen drafts that were
  // never made.
  describe('a step that only half worked', () => {
    const partial: PipelineStep[] = [
      { name: 'postiz', label: 'Postiz', status: 'partial' },
      { name: 'clipper', label: 'Clipper', status: 'completed' },
    ];

    it('says it is partly done, and that pressing it finishes the job', () => {
      render(<PipelineController onExecute={vi.fn()} steps={partial} />);

      expect(screen.getByRole('button', { name: /Postiz/i }).textContent).toContain(
        'partly done — press to finish'
      );
    });

    it('is painted as neither done nor failed', () => {
      render(<PipelineController onExecute={vi.fn()} steps={partial} />);

      const button = screen.getByRole('button', { name: /Postiz/i });
      expect(button.style.getPropertyValue('--step-dot')).toBe('var(--warning)');
      expect(button.className).not.toContain('pipeline-step-success');
    });

    it('runs the step rather than stopping it when pressed', () => {
      const onExecute = vi.fn();
      render(<PipelineController onExecute={onExecute} steps={partial} />);

      fireEvent.click(screen.getByRole('button', { name: /Postiz/i }));

      expect(onExecute).toHaveBeenCalledWith('START', 'postiz');
    });

    it('does not let the pipeline celebrate finishing', () => {
      const { rerender } = render(
        <PipelineController onExecute={vi.fn()} steps={[{ ...partial[0], status: 'todo' }]} />
      );
      rerender(<PipelineController onExecute={vi.fn()} steps={[partial[0]]} />);

      expect(document.querySelector('.sweep-clip')).toBeNull();
    });

    it('carries to the collapsed AI button, where a done badge would hide it', () => {
      render(
        <PipelineController
          onExecute={vi.fn()}
          steps={[
            { name: 'highlights', label: 'Highlights', status: 'completed', isLlm: true },
            { name: 'chapters', label: 'Chapters', status: 'partial', isLlm: true },
          ]}
        />
      );

      expect(
        screen.getByRole('button', { name: /AI Steps/i }).style.getPropertyValue('--step-dot')
      ).toBe('var(--warning)');
    });
  });
});

// "Running" is the same word for a step three seconds in and a step six
// minutes into a request that will never return. The line under the row is
// where that difference lives.
describe('PipelineActivity', () => {
  const running: PipelineStep[] = [
    { name: 'transcription', label: 'Transcription', status: 'completed' },
    { name: 'highlights', label: 'Highlights', status: 'running', isLlm: true },
  ];

  it('says how long the step has been going, before it has said anything else', () => {
    render(
      <PipelineActivity steps={running} activity={{ highlights: { since: 1000 } }} now={1372} />
    );

    expect(screen.getByText(/Highlights · 6m 12s/)).toBeDefined();
  });

  it('says what the step is waiting on once it reports', () => {
    render(
      <PipelineActivity
        steps={running}
        activity={{
          highlights: {
            since: 1000,
            at: 1360,
            message: 'gemini-3.7-flash: Google says the model is overloaded. Trying again in 21s — attempt 3 of 4.',
          },
        }}
        now={1048}
      />
    );

    expect(screen.getByText(/attempt 3 of 4/)).toBeDefined();
    expect(screen.getByText(/Highlights · 48s/)).toBeDefined();
  });

  // It changes under a user who is doing something else on the page, and it is
  // never urgent enough to interrupt them.
  it('is announced politely rather than assertively', () => {
    const { container } = render(
      <PipelineActivity steps={running} activity={{ highlights: { since: 0 } }} now={5} />
    );

    expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('draws nothing for a step that is not running', () => {
    const done: PipelineStep[] = [{ name: 'highlights', label: 'Highlights', status: 'completed' }];
    const { container } = render(
      <PipelineActivity steps={done} activity={{ highlights: { since: 0 } }} now={99} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('draws nothing when the backend sent no activity at all', () => {
    const { container } = render(<PipelineActivity steps={running} />);

    expect(container.firstChild).toBeNull();
  });

  // A step that stopped is the case the activity entry cannot cover: the entry
  // is dropped when the job ends, which is the moment the reason starts
  // mattering. Without this, "error" was a colour and the reason was in the
  // backend log.
  it('says why a failed step stopped, after it has stopped', () => {
    const failed: PipelineStep[] = [
      {
        name: 'postiz',
        label: 'Postiz Drafts',
        status: 'error',
        error: 'No Postiz API key is configured. Add one in Settings.',
      },
    ];

    render(<PipelineActivity steps={failed} activity={{}} now={5} />);

    expect(screen.getByText(/Postiz Drafts stopped/)).toBeDefined();
    expect(screen.getByText(/No Postiz API key is configured/)).toBeDefined();
  });

  it('says nothing about a failed step that gave no reason', () => {
    const failed: PipelineStep[] = [{ name: 'chapters', label: 'Chapters', status: 'error' }];
    const { container } = render(<PipelineActivity steps={failed} activity={{}} now={5} />);

    expect(container.firstChild).toBeNull();
  });

  it('shows a reason even when the backend sent no activity at all', () => {
    const failed: PipelineStep[] = [
      { name: 'postiz', label: 'Postiz Drafts', status: 'error', error: 'Postiz answered 500' },
    ];

    render(<PipelineActivity steps={failed} />);

    expect(screen.getByText(/Postiz answered 500/)).toBeDefined();
  });

  // The amber badge says "some of it did not happen". This is the only place
  // that says which part, and it has to survive the run that produced it.
  it('says which part of a partly done step is still missing', () => {
    const partial: PipelineStep[] = [
      {
        name: 'postiz',
        label: 'Postiz Drafts',
        status: 'partial',
        error: '3 of 4 clips are not in Postiz yet. Run this step again to import only those.',
      },
    ];

    render(<PipelineActivity steps={partial} activity={{}} now={5} />);

    expect(screen.getByText(/Postiz Drafts partly done/)).toBeDefined();
    expect(screen.getByText(/3 of 4 clips are not in Postiz yet/)).toBeDefined();
  });

  it('says nothing about a partly done step that gave no reason', () => {
    const partial: PipelineStep[] = [{ name: 'clipper', label: 'Clipper', status: 'partial' }];
    const { container } = render(<PipelineActivity steps={partial} activity={{}} now={5} />);

    expect(container.firstChild).toBeNull();
  });
});
