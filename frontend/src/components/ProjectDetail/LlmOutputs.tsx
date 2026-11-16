import React from 'react';
import { ChaptersPanel } from './Chapters';
import { stepLabel } from '../../utils/stepLabels';

interface LlmOutputsProps {
  projectId: string;
  outputs: Record<string, unknown>;
}

// Tasks with a purpose-built view. Everything else falls back to the generic
// table, which is what keeps a brand-new prompt viewable with no code.
type PanelProps = { projectId: string; output: unknown };

const CUSTOM_PANELS: Record<string, React.FC<PanelProps> | undefined> = {
  chapters: ({ projectId, output }) => <ChaptersPanel projectId={projectId} output={output} />,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A task defined purely by a prompt file has no bespoke view, so its output is
 * unwrapped to the most table-like shape available: a `{ "chapters": [...] }`
 * response renders as the rows of that array.
 */
const toRows = (value: unknown): Record<string, unknown>[] | null => {
  let candidate = value;
  if (isPlainObject(candidate)) {
    const arrays = Object.values(candidate).filter(Array.isArray);
    if (arrays.length !== 1) return null;
    candidate = arrays[0];
  }
  if (!Array.isArray(candidate) || candidate.length === 0) return null;
  return candidate.every(isPlainObject) ? (candidate as Record<string, unknown>[]) : null;
};

// For table column headings, which are raw keys from a model's JSON rather
// than anything the interface has a name for. Step names go through
// stepLabel instead, so a task is called the same thing here as in the
// pipeline row above it.
const humanize = (key: string) => key.replace(/_/g, ' ').toUpperCase();

// A prompt can return an unbounded list, and every row here is uncollapsed DOM
// inside an always-open <details>.
const ROW_LIMIT = 200;

const OutputTable: React.FC<{ rows: Record<string, unknown>[]; label: string }> = ({ rows, label }) => {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const visibleRows = rows.slice(0, ROW_LIMIT);

  return (
    // A prompt can return more columns than fit, and this is the only thing on
    // the page that scrolls sideways. Without a tabindex the scroll container
    // holds no focusable child, so a keyboard alone cannot reach the overflow.
    <div
      role="region"
      aria-label={`${label} output`}
      tabIndex={0}
      style={{ overflowX: 'auto' }}
    >
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                style={{
                  textAlign: 'left',
                  padding: 'var(--space-xs) var(--space-sm)',
                  borderBottom: 'var(--border)',
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  whiteSpace: 'nowrap',
                }}
              >
                {humanize(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column}
                  style={{
                    padding: 'var(--space-xs) var(--space-sm)',
                    borderBottom: '1px solid var(--border-color)',
                    verticalAlign: 'top',
                    // A serialised object in one cell would otherwise stretch
                    // the table to a single unreadable line.
                    maxWidth: '48ch',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {typeof row[column] === 'object' && row[column] !== null
                    ? JSON.stringify(row[column])
                    : String(row[column] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > ROW_LIMIT && (
        <p style={{ margin: 'var(--space-sm) 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Showing the first {ROW_LIMIT} of {rows.length} rows.
        </p>
      )}
    </div>
  );
};

export const LlmOutputs: React.FC<LlmOutputsProps> = ({ projectId, outputs }) => {
  const entries = Object.entries(outputs || {});
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([task, value]) => {
        const CustomPanel = CUSTOM_PANELS[task];
        const rows = CustomPanel ? null : toRows(value);
        return (
          <details key={task} open style={{ border: 'var(--border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-sm)' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 500}}>
              {stepLabel(task)}
            </summary>
            <div style={{ marginTop: 'var(--space-sm)' }}>
              {CustomPanel ? (
                <CustomPanel projectId={projectId} output={value} />
              ) : rows ? (
                <OutputTable rows={rows} label={stepLabel(task)} />
              ) : (
                <pre style={{ margin: 0, fontSize: '0.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                </pre>
              )}
            </div>
          </details>
        );
      })}
    </>
  );
};
