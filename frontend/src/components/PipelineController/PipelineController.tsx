import React from 'react';
import type { StepActivity } from '../../api';

/**
 * `partial` is a step that did some of its clips and not the rest — nineteen of
 * twenty drafts filed, three clips that would not cut. It is neither of the two
 * things the badge used to say: "done" sends the user looking for drafts that
 * were never made, and "failed" throws away the nineteen that are there.
 * Pressing a partial step runs only what is still missing.
 */
export type StepStatus =
  | 'todo'
  | 'running'
  | 'executed'
  | 'completed'
  | 'partial'
  | 'error'
  | 'locked';

export interface PipelineStep {
  name: string;
  label: string;
  status: StepStatus;
  // Steps backed by a prompt in backend/config/prompts. They are collapsed
  // behind a single button so adding a prompt does not keep widening the row.
  isLlm?: boolean;
  /** Labels of the steps that must run first, used to explain a locked state. */
  dependsOn?: string[];
  /**
   * Why this step failed, for a step that says. `error` on its own is a colour:
   * it sent the user to the backend log for things as ordinary as an API key
   * nobody had filled in. Present while the status is `error`, and while it is
   * `partial` — there the sentence carries how many clips are still missing,
   * which is the only place that number is written down.
   */
  error?: string;
}

interface PipelineControllerProps {
  onExecute: (action: 'START' | 'STOP', step: string) => void;
  steps: PipelineStep[];
  /**
   * How much of the page this row is entitled to.
   *
   * `lead` is a project with nothing in it: there is nothing to review yet, so
   * running the pipeline is the only thing to do here and the row says so —
   * filled run button, full-height steps.
   *
   * `compact` is a project that has already produced clips. The pipeline is
   * then a tool you reach for rather than the thing you came to look at, and
   * the grid below has a better claim on the fold. The run-everything button
   * also stops being the loudest control on a page where it is the one you
   * least want to press by accident.
   */
  prominence?: 'lead' | 'compact';
}

/** Whether this step has produced everything it was asked for. */
export const isStepDone = (status: StepStatus) => status === 'executed' || status === 'completed';

const stepColors = (status: StepStatus) => {
  const isExecuted = isStepDone(status);
  const isRunning = status === 'running';
  const isError = status === 'error';
  // Its own colour rather than a faded green or a second red. Half-done is a
  // state the user is meant to act on, and it has to be told apart from both
  // the state that needs nothing and the state that produced nothing.
  const isPartial = status === 'partial';
  // Neutral surfaces with a status dot (see index.css), so the row is not a
  // strip of five fills competing with the clips. Only the two states that
  // ask for attention, running and failed, tint the whole button.
  const tint = isError ? 'var(--error)' : isRunning ? 'var(--accent)' : null;
  return {
    background: tint ? `color-mix(in srgb, ${tint} 8%, var(--bg-raised))` : 'var(--bg-raised)',
    borderColor: tint ? `color-mix(in srgb, ${tint} 35%, transparent)` : 'var(--hairline)',
    color: tint ?? 'var(--text)',
    '--step-dot': isPartial ? 'var(--warning)' : isExecuted ? 'var(--success)' : 'var(--hairline-strong)',
  } as React.CSSProperties;
};

/**
 * The worst status wins, so a failed prompt is visible on the collapsed button
 * without opening the dropdown.
 */
const aggregateStatus = (steps: PipelineStep[]): StepStatus => {
  if (steps.some((s) => s.status === 'error')) return 'error';
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.some((s) => s.status === 'partial')) return 'partial';
  if (steps.every((s) => isStepDone(s.status))) return 'completed';
  if (steps.every((s) => s.status === 'locked')) return 'locked';
  return 'todo';
};

/**
 * A touch tap fires pointerenter and often never fires the matching leave, so
 * hover-driven state latches on and stays on. Only a real pointer gets it.
 */
const isHoverPointer = (event: React.PointerEvent) => event.pointerType === 'mouse';

/** The dropdown's own minimum, needed before it has been rendered to measure. */
const MENU_MIN_WIDTH = 240;

const stepButtonStyle = (
  status: StepStatus,
  isHovered: boolean,
  isCompact = false
): React.CSSProperties => {
  const isLocked = status === 'locked';
  return {
    display: 'flex',
    // A strip reads along its length, so the status sits beside the step name
    // rather than under it. Stacked, every cell needed two lines of height and
    // the row could not be one line tall however short the buttons got.
    flexDirection: isCompact ? 'row' : 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: isCompact ? 'var(--space-sm)' : undefined,
    textAlign: 'center',
    // Grid cells stretch; strip items are as wide as their label.
    width: isCompact ? 'auto' : '100%',
    padding: isCompact ? '0 var(--space-md)' : 'var(--space-sm)',
    // 44px is the floor for a target, not a comfortable size for one — which
    // is exactly what the compact row is trading away for the fold.
    minHeight: isCompact ? '44px' : '60px',
    whiteSpace: isCompact ? 'nowrap' : undefined,
    border: 'var(--border)', borderRadius: 'var(--radius)',
    ...stepColors(status),
    opacity: isLocked ? 0.5 : 1,
    cursor: isLocked ? 'not-allowed' : 'pointer',
    transition: 'background-color 150ms var(--ease-out-quart), border-color 150ms var(--ease-out-quart), color 150ms var(--ease-out-quart)',
    position: 'relative',
    overflow: 'hidden',
    ...(isHovered && !isLocked && { background: 'var(--btn-hover-bg)' }),
  };
};

const LlmStepMenu: React.FC<{
  steps: PipelineStep[];
  onExecute: PipelineControllerProps['onExecute'];
  isCompact?: boolean;
}> = ({ steps, onExecute, isCompact = false }) => {
  const [isHovered, setIsHovered] = React.useState(false);
  // Hover is only a preview. Pressing the button pins the dropdown so the rows
  // inside it can actually be reached and clicked.
  const [isPinned, setIsPinned] = React.useState(false);
  // The trigger is a grid cell that can sit anywhere in the row, but the menu
  // is at least MENU_MIN_WIDTH wide. Opened from a cell near the right edge it
  // used to run off the side of the page, so it flips to right-aligned when
  // there is not room to open leftwards.
  const [alignRight, setAlignRight] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const status = aggregateStatus(steps);
  const isOpen = isPinned || isHovered;

  const closeAndRefocus = React.useCallback(() => {
    setIsPinned(false);
    triggerRef.current?.focus();
  }, []);

  // Measured in the handler that opens the menu rather than in an effect, so
  // the menu is positioned on the render that first paints it.
  const measureAlignment = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, MENU_MIN_WIDTH);
    setAlignRight(rect.left + width > document.documentElement.clientWidth);
  }, []);

  React.useEffect(() => {
    if (!isPinned) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsPinned(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAndRefocus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isPinned, closeAndRefocus]);

  // Opening with the keyboard has to land focus inside the menu, otherwise Tab
  // walks past the rows it just opened.
  React.useEffect(() => {
    if (!isPinned) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [isPinned]);

  const runStep = (step: PipelineStep) => {
    if (step.status === 'locked') return;
    onExecute(step.status === 'running' ? 'STOP' : 'START', step.name);
  };

  // `role="menu"` promises arrow-key navigation; a plain list of buttons inside
  // it does not deliver that on its own.
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);

    const focusAt = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length].focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        return focusAt(current + 1);
      case 'ArrowUp':
        return focusAt(current - 1);
      case 'Home':
        return focusAt(0);
      case 'End':
        return focusAt(items.length - 1);
      case 'Tab':
        return setIsPinned(false);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: isCompact ? 'auto' : undefined }}
      onPointerEnter={(event) => {
        if (!isHoverPointer(event)) return;
        measureAlignment();
        setIsHovered(true);
      }}
      onPointerLeave={(event) => {
        if (!isHoverPointer(event)) return;
        setIsHovered(false);
      }}
    >
      <button
        ref={triggerRef}
        onClick={() => {
          measureAlignment();
          setIsPinned((pinned) => !pinned);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !isPinned) {
            event.preventDefault();
            measureAlignment();
            setIsPinned(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        className="pipeline-step"
        style={stepButtonStyle(status, isOpen, isCompact)}
      >
        {/* "LLM Queries" named the implementation. These are the steps where a
            model writes something, which is what the user is choosing between. */}
        <span style={{ fontWeight: 500, fontSize: isCompact ? '0.8rem' : '1rem'}}>
          AI steps
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isPinned ? 'rotate(180deg)' : undefined, transition: 'transform 150ms var(--ease-out-quart)', color: 'var(--text-muted)' }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label="AI steps"
          onKeyDown={onMenuKeyDown}
          // Short: a menu is a response to a press, so it should feel like it
          // was already there rather than like it is arriving.
          className="menu-enter"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: alignRight ? 'auto' : 0,
            right: alignRight ? 0 : 'auto',
            minWidth: `max(100%, ${MENU_MIN_WIDTH}px)`,
            // Last resort for a viewport narrower than the menu's own minimum.
            maxWidth: 'calc(100vw - var(--space-xl))',
            zIndex: 20,
            border: 'var(--border)', borderRadius: 'var(--radius-lg)',
            background: 'var(--bg)',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          {steps.map((step) => {
            const isLocked = step.status === 'locked';
            return (
              <button
                key={step.name}
                role="menuitem"
                disabled={isLocked}
                onClick={() => runStep(step)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-md)',
                  padding: 'var(--space-sm)',
                  border: 'none',
                  borderBottom: 'var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: isLocked ? 'not-allowed' : 'pointer',
                  opacity: isLocked ? 0.4 : 1,
                  fontWeight: 500,
                  fontSize: '0.8rem',
                  textAlign: 'left',
                }}
              >
                <span>{step.label}</span>
                <span className="status-badge" style={stepColors(step.status)}>
                  {step.status === 'running' ? 'stop' : statusLabel(step)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Status is otherwise carried by fill colour alone, which is invisible to a
// colourblind user, in high-contrast mode, and to a screen reader.
const statusLabel = (step: PipelineStep): string => {
  switch (step.status) {
    case 'executed':
    case 'completed':
      return 'done';
    case 'running':
      return 'running — press to stop';
    case 'partial':
      // Says what to do about it, because there is something to do about it:
      // pressing it again picks up only the clips that are still missing.
      return 'partly done — press to finish';
    case 'error':
      return 'failed';
    case 'locked':
      // "Locked" states that the button will not work but not what would make
      // it work, which is the only thing the user can act on.
      return step.dependsOn?.length ? `run ${step.dependsOn.join(' and ')} first` : 'locked';
    default:
      return 'not run';
  }
};

const PipelineControllerRow: React.FC<PipelineControllerProps> = ({ onExecute, steps, prominence = 'lead' }) => {
  const isCompact = prominence === 'compact';
  const [hoveredStep, setHoveredStep] = React.useState<string | null>(null);

  const llmSteps = steps.filter((step) => step.isLlm);
  const anyRunning = steps.some((step) => step.status === 'running');
  // A partial step is deliberately not complete: the celebration below is the
  // page saying there is nothing left to do, and there is.
  const allComplete = steps.length > 0 && steps.every((step) => isStepDone(step.status));

  // Same latch as the clip cards: true only when the pipeline finished while
  // this page was open. Reopening a finished project is silent.
  const [wasIncompleteAtMount] = React.useState(() => !allComplete);
  const celebrateComplete = allComplete && wasIncompleteAtMount;
  // The collapsed button takes the slot of the first LLM step, so the row still
  // reads in execution order.
  const firstLlmIndex = steps.findIndex((step) => step.isLlm);

  const runAll = (
    <button
      onClick={() => onExecute('START', 'all')}
      // A second press while the pipeline runs queues a duplicate run of
      // every step against the same project directory.
      disabled={anyRunning}
      aria-busy={anyRunning}
      style={{
        // Full width only when it leads. In the strip it is one item among the
        // steps: a button that owns a row of its own is a button the page is
        // telling you to press, which is the wrong thing to say about
        // re-running everything on a project that already has clips.
        width: isCompact ? 'auto' : '100%',
        padding: isCompact ? '0 var(--space-md)' : 'var(--space-sm)',
        minHeight: '44px',
        border: 'var(--border)', borderRadius: 'var(--radius)',
        // Ghost once the project has clips in it. A filled black bar is a
        // promise that this is the thing to press, and on a finished
        // project pressing it re-runs everything.
        backgroundColor: isCompact ? 'transparent' : 'var(--text)',
        color: isCompact ? 'var(--text)' : 'var(--bg)',
        fontWeight: 500,
        fontSize: isCompact ? '0.8rem' : '1rem',
        whiteSpace: isCompact ? 'nowrap' : undefined,
        cursor: anyRunning ? 'not-allowed' : 'pointer',
        opacity: anyRunning ? 0.5 : 1,
        textAlign: 'center',
        transition: 'background-color 150ms var(--ease-out-quart), border-color 150ms var(--ease-out-quart), color 150ms var(--ease-out-quart)',
      }}
    >
      {anyRunning ? 'Pipeline running…' : 'Run full pipeline'}
    </button>
  );

  const stepButtons = steps.map((step, index) => {
    if (step.isLlm) {
      if (index !== firstLlmIndex) return null;
      return <LlmStepMenu key="llm-queries" steps={llmSteps} onExecute={onExecute} isCompact={isCompact} />;
    }

    const isRunning = step.status === 'running';
    const isLocked = step.status === 'locked';
    const isHovered = hoveredStep === step.name;

    return (
      <button
        key={step.name}
        disabled={isLocked}
        onClick={() => onExecute(isRunning ? 'STOP' : 'START', step.name)}
        // Pointer-typed: a tap would otherwise leave the hover shadow
        // stuck on the last step touched.
        onPointerEnter={(event) => isHoverPointer(event) && setHoveredStep(step.name)}
        onPointerLeave={(event) => isHoverPointer(event) && setHoveredStep(null)}
        aria-busy={isRunning}
        className={`pipeline-step-btn ${isRunning ? 'pipeline-step-running' : ''} ${isStepDone(step.status) ? 'pipeline-step-success' : ''} ${step.status === 'error' ? 'pipeline-step-error' : ''} pipeline-step`}
        style={stepButtonStyle(step.status, isHovered, isCompact)}
      >
        <span style={{ fontWeight: 500, fontSize: isCompact ? '0.8rem' : '1rem'}}>
          {step.label}
        </span>
        {/* No opacity here. This label is the reason status is not
            colour-only (see statusLabel), and fading it to 0.85 over the
            accent fill put it at 3.4:1 — below the threshold it exists
            to satisfy. */}
        <span style={{ fontWeight: 500, fontSize: '0.75rem'}}>
          {statusLabel(step)}
        </span>
      </button>
    );
  });

  // The whole run landing. Sits under the dropdown's z-index and is clipped by
  // its own wrapper, so it cannot bleed over the row or trap pointer events.
  const sweep = celebrateComplete && (
    <span className="sweep-clip" aria-hidden="true">
      <span className="sweep-band sweep-band--success" />
    </span>
  );

  // One line, not three.
  // --------------------------------------------------------------------------
  // Compact used to mean "the same two blocks, with smaller buttons": a
  // full-width run bar on its own row, then a grid whose 140px minimum track
  // wrapped the steps onto two or three rows — and onto one row *each* below
  // 600px, where the grid collapses to a single column. Six steps came to
  // 324px of pipeline before the run bar was counted, which is how a tool row
  // ended up holding half the page against the clip grid it exists to fill.
  if (isCompact) {
    return (
      <div className="pipeline-controller">
        <div className="pipeline-strip" style={{ position: 'relative' }}>
          {sweep}
          {runAll}
          {stepButtons}
        </div>
      </div>
    );
  }

  return (
    <div className="pipeline-controller">
      <div style={{ marginBottom: 'var(--space-md)' }}>{runAll}</div>
      <div className="pipeline-steps" style={{ position: 'relative' }}>
        {sweep}
        {stepButtons}
      </div>
    </div>
  );
};

/** "6m 12s", "48s". Seconds are kept all the way up: a step that has been
 *  going for eight minutes and one that has been going for eight minutes and
 *  fifty seconds are different amounts of patience to ask for. */
const elapsed = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes > 0 ? `${minutes}m ${whole % 60}s` : `${whole}s`;
};

interface PipelineActivityProps {
  steps: PipelineStep[];
  /** Keyed by step name, from `/execution_status`. */
  activity?: Record<string, StepActivity>;
  /** The backend's clock at the moment `activity` was read, in epoch seconds. */
  now?: number;
}

/**
 * What the running step is doing — and why a failed one stopped — under the row.
 *
 * The row itself can only say "running", and for the LLM steps that word
 * covers a single HTTP request that can take minutes — during which an
 * overloaded model being retried for the fourth time and a request that will
 * never return look exactly alike, which is to say they both look like the
 * application has hung. This is the only place that difference is visible.
 *
 * Deliberately outside the memoised row: this re-renders on every poll,
 * because the elapsed time is a second older each time, and the row is a dozen
 * buttons that change three or four times in a whole pipeline.
 */
export const PipelineActivity: React.FC<PipelineActivityProps> = ({ steps, activity, now }) => {
  const clock = now ?? Date.now() / 1000;

  const running = activity
    ? steps
        .filter((step) => step.status === 'running' && activity[step.name])
        .map((step) => ({ step, entry: activity[step.name] }))
    : [];

  // A reason outlives the run it came from: it is read after the step has
  // stopped, which is the moment the activity entry above is thrown away.
  const failed = steps.filter((step) => step.status === 'error' && step.error);
  // The same treatment for a step that half worked. Its sentence is the only
  // place the count lives — "three of twenty clips are not in Postiz yet" —
  // and without it the amber badge is a colour saying "something".
  const incomplete = steps.filter((step) => step.status === 'partial' && step.error);

  if (running.length === 0 && failed.length === 0 && incomplete.length === 0) return null;

  return (
    <div
      // Polite, not assertive: this changes while the user is doing something
      // else on the page, and it is never urgent enough to interrupt.
      role="status"
      aria-live="polite"
      style={{
        marginTop: 'var(--space-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-sm)',
      }}
    >
      {running.map(({ step, entry }) => (
        <p
          key={step.name}
          style={{
            margin: 0,
            fontSize: '0.75rem',
            fontWeight: 500,
            lineHeight: 1.4,
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ color: 'var(--accent)'}}>
            {step.label} · {elapsed(clock - entry.since)}
          </span>
          {/* Until something inside the step reports, the elapsed time is the
              whole message — and it is already more than "running" said. */}
          {entry.message ? ` — ${entry.message}` : ''}
        </p>
      ))}
      {failed.map((step) => (
        <p
          key={step.name}
          style={{
            margin: 0,
            fontSize: '0.75rem',
            fontWeight: 500,
            lineHeight: 1.4,
            // The reason is the message, so it carries the colour rather than
            // only the step name in front of it.
            color: 'var(--error)',
            overflowWrap: 'anywhere',
          }}
        >
          <span style={{ fontWeight: 500 }}>
            {step.label} stopped
          </span>
          {` — ${step.error}`}
        </p>
      ))}
      {incomplete.map((step) => (
        <p
          key={step.name}
          style={{
            margin: 0,
            fontSize: '0.75rem',
            fontWeight: 500,
            lineHeight: 1.4,
            color: 'var(--warning-text)',
            overflowWrap: 'anywhere',
          }}
        >
          <span style={{ fontWeight: 500 }}>
            {step.label} partly done
          </span>
          {` — ${step.error}`}
        </p>
      ))}
    </div>
  );
};

/**
 * Memoised: the project page re-renders twice a second while a step runs, and
 * this row is a dozen buttons plus a menu that only change when a status
 * changes — three or four times over a whole pipeline. `steps` is memoised by
 * the caller on the statuses themselves, and `onExecute` is a `useCallback` up
 * in App, so the bail-out actually holds.
 */
export const PipelineController = React.memo(PipelineControllerRow);
