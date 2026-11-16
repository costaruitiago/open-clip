import React, { useEffect, useRef, useState } from 'react';

interface DateFieldProps {
  id: string;
  /** The stored day, as YYYY-MM-DD, or '' for none. */
  value: string;
  /** Called with the new day, or '' when the field is cleared. Never mid-edit. */
  onCommit: (value: string) => void;
  /** The earliest and latest day this field will accept, as YYYY-MM-DD. */
  min?: string;
  max?: string;
  style?: React.CSSProperties;
  'aria-describedby'?: string;
}

/** Whether a day is one this field would accept, bounds included. */
const inRange = (value: string, min?: string, max?: string): boolean => {
  if (!value) return false;
  // String comparison, which is what YYYY-MM-DD is for: it sorts as a date.
  if (min && value < min) return false;
  if (max && value > max) return false;
  return true;
};

/**
 * A day, typed or picked from the browser's calendar.
 *
 * Held locally and committed rather than saved on every keystroke. A
 * `type="date"` input reports its value only once all three segments are
 * filled, and a year typed digit by digit fills them repeatedly on the way:
 * 2026 arrives as 0002, then 0020, then 0202. Saving each of those wrote a
 * year in antiquity and the refetch put it back in the box under the cursor,
 * which is how a field becomes impossible to correct.
 *
 * So a change is committed only when the day is one `min`/`max` allow, and
 * anything else waits for the field to be left. A day out of those bounds is
 * never committed: on leaving, the field goes back to what was stored.
 *
 * The calendar is a button of its own rather than the whole field, because a
 * picker that opens on every click is a field that cannot be typed into.
 */
export const DateField: React.FC<DateFieldProps> = ({
  id,
  value,
  onCommit,
  min,
  max,
  style,
  'aria-describedby': describedBy,
}) => {
  const ref = useRef<HTMLInputElement>(null);
  // A stored day the bounds would refuse — a year saved before there were
  // bounds — shows as empty rather than as itself. Left in the box it opens
  // the calendar in the wrong century, and it is the one value the user cannot
  // edit their way out of.
  const shown = inRange(value, min, max) ? value : '';
  const [draft, setDraft] = useState(shown);
  // What the field shows while it is being edited is the user's, not the
  // server's: a metadata refresh mid-edit must not rewrite a half-typed day.
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!isEditing) setDraft(shown);
  }, [shown, isEditing]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  return (
    <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'stretch' }}>
      <input
        id={id}
        ref={ref}
        type="date"
        value={draft}
        min={min}
        max={max}
        style={{ flex: 1, ...style }}
        aria-describedby={describedBy}
        onFocus={() => setIsEditing(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          // A whole day, and one this field would accept: what the calendar
          // produces in one go, and what typing produces on the last digit.
          // Anything else is a year on its way to being typed.
          if (inRange(e.target.value, min, max)) commit(e.target.value);
        }}
        onBlur={(e) => {
          setIsEditing(false);
          const typed = e.target.value;
          if (!typed || inRange(typed, min, max)) {
            // Empty is an answer — it means "as soon as the upload is done" —
            // so leaving the field empty saves that.
            commit(typed);
          } else {
            // A day outside the bounds is a typo, not an instruction: the box
            // goes back to what is actually stored. Leaving the field is what
            // puts it back — see the effect above.
            setDraft(shown);
          }
        }}
      />
      <button
        type="button"
        aria-label="Open calendar"
        title="Open calendar"
        onClick={() => {
          try {
            // Focused first, so a browser that opens the picker over the
            // field puts the day it returns into this one.
            ref.current?.focus();
            ref.current?.showPicker?.();
          } catch {
            /* Firefox has no picker to show, and the field is still typeable. */
          }
        }}
        style={{ padding: '0 var(--space-sm)', minHeight: '44px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: 'var(--text-secondary)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
      </button>
    </div>
  );
};
