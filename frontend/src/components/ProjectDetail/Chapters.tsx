import React from 'react';
import { Button } from '../Button';
import { getChapterEdlUrl, getChapterTextUrl } from '../../api';

export interface Chapter {
  seconds: number;
  title: string;
}

/** Parses `HH:MM:SS`, `MM:SS`, `SS`, or a number, into seconds. */
export const parseTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string') return null;

  const parts = value.trim().split(':');
  if (parts.length === 0 || parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    const number = Number(part);
    if (part.trim() === '' || Number.isNaN(number) || number < 0) return null;
    seconds = seconds * 60 + number;
  }
  return seconds;
};

/** YouTube-style `M:SS`, or `H:MM:SS` once any chapter passes the hour. */
export const formatTimestamp = (seconds: number, withHours: boolean): string => {
  const total = Math.max(0, Math.floor(seconds));
  const ss = total % 60;
  const minutes = Math.floor(total / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (withHours) return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(ss)}`;
  return `${minutes}:${pad(ss)}`;
};

const TIME_KEYS = ['chapter_time', 'time', 'timestamp', 'start', 'start_time'];
const TITLE_KEYS = ['chapter_title', 'title', 'chapter_summary', 'summary', 'name'];

const pick = (row: Record<string, unknown>, keys: string[]) =>
  keys.map((key) => row[key]).find((value) => value !== undefined);

/** Mirrors the backend export so the copied text matches the downloaded file. */
export const toChapters = (output: unknown): Chapter[] => {
  const items = Array.isArray(output)
    ? output
    : (output as Record<string, unknown>)?.chapters;
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item, index) => ({
      seconds: parseTimestamp(pick(item, TIME_KEYS)),
      title: String(pick(item, TITLE_KEYS) ?? `Chapter ${index + 1}`).trim(),
    }))
    .filter((chapter): chapter is Chapter => chapter.seconds !== null)
    .sort((a, b) => a.seconds - b.seconds);
};

export const toYouTubeText = (chapters: Chapter[]): string => {
  const withHours = chapters.length > 0 && chapters[chapters.length - 1].seconds >= 3600;
  return chapters.map((c) => `${formatTimestamp(c.seconds, withHours)} ${c.title}`).join('\n');
};

interface ChaptersPanelProps {
  projectId: string;
  output: unknown;
}

export const ChaptersPanel: React.FC<ChaptersPanelProps> = ({ projectId, output }) => {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const chapters = React.useMemo(() => toChapters(output), [output]);
  const text = React.useMemo(() => toYouTubeText(chapters), [chapters]);

  if (chapters.length === 0) {
    return <div style={{ color: 'var(--text-muted)' }}>No readable chapters in this result.</div>;
  }

  const copy = async () => {
    try {
      // Absent over plain HTTP and denied when the page isn't focused, so the
      // happy path is not guaranteed even in a current browser.
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      console.warn('Clipboard write failed', err);
      setCopyState('failed');
    }
  };

  // YouTube silently ignores a chapter list unless it starts at zero and has at
  // least three entries, which is worth knowing before pasting it.
  const warnings = [
    chapters[0].seconds !== 0 ? 'First chapter is not at 0:00 — YouTube needs one there.' : null,
    chapters.length < 3 ? 'YouTube needs at least 3 chapters.' : null,
  ].filter(Boolean);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button variant="ghost" onClick={copy} style={{ fontSize: '0.75rem', padding: '0.5rem 1rem', minHeight: '44px' }}>
          {copyState === 'copied' ? 'Copied' : 'Copy for YouTube'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { window.location.href = getChapterTextUrl(projectId); }}
          style={{ fontSize: '0.75rem', padding: '0.5rem 1rem', minHeight: '44px' }}
        >
          Download .txt
        </Button>
        <Button
          variant="ghost"
          onClick={() => { window.location.href = getChapterEdlUrl(projectId); }}
          style={{ fontSize: '0.75rem', padding: '0.5rem 1rem', minHeight: '44px' }}
        >
          Export Chapter Markers
        </Button>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`}
        </span>
      </div>

      {copyState === 'failed' && (
        <p role="alert" style={{ margin: 0, fontSize: '0.75rem', color: 'var(--error)' }}>
          Copy failed — this browser blocked clipboard access. Select the text below and copy it, or download the .txt.
        </p>
      )}

      {warnings.map((warning) => (
        <p key={warning} role="alert" style={{ margin: 0, fontSize: '0.75rem', color: 'var(--error)' }}>
          {warning}
        </p>
      ))}

      {/* The paste target: exactly the text YouTube parses, nothing around it. */}
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-sm)',
          border: 'var(--border)', borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-secondary)',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'all',
        }}
      >
        {text}
      </pre>
    </div>
  );
};
