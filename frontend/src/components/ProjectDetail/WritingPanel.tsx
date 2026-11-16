import React from 'react';
import { LlmOutputs } from './LlmOutputs';
import type { VideoMetadata, VideoTitle } from '../../api';

interface WritingPanelProps {
  projectId: string;
  /** What the Metadata step wrote, or undefined before it has run. */
  videoMetadata: VideoMetadata | undefined;
  /** Output of prompt-defined LLM tasks, rendered under the writing. */
  llmOutputs: Record<string, unknown>;
}

const cardStyle: React.CSSProperties = {
  padding: 'var(--space-md)',
  border: 'var(--border)', borderRadius: 'var(--radius-lg)',
  background: 'var(--bg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-sm)',
  // Model output is arbitrary text: a URL or an unspaced CJK run has no break
  // opportunity and would otherwise widen the whole page.
  overflowWrap: 'anywhere',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 500,
  color: 'var(--text-muted)',
};

/**
 * The project's own writing: the title candidates and the description the
 * Metadata step wrote for the whole video.
 *
 * This panel used to page through the highlights instead, which was the wrong
 * thing in the wrong place twice over — a highlight's hook, quote and social
 * posts belong to one clip and are already on that clip, and the one piece of
 * writing that is about the project had nowhere to be read at all. The backend
 * has been sending `video_metadata` since the step was written; nothing showed
 * it.
 */
const TitleRow: React.FC<{ item: VideoTitle; position: number; isTop: boolean }> = ({
  item,
  position,
  isTop,
}) => (
  <div
    style={{
      borderTop: isTop
        ? 'var(--border-width) solid var(--accent)'
        : 'var(--border)',
      paddingTop: 'var(--space-sm)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-sm)',
      minWidth: 0,
    }}
  >
    <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ ...labelStyle, minWidth: '1.5rem' }}>{position + 1}</span>
      <span style={{ fontSize: '0.95rem', fontWeight: 500, color: isTop ? 'var(--text-accent)' : 'var(--text-main)' }}>
        {item.title}
      </span>
      {isTop && <span className="status-badge">Top pick</span>}
    </div>
    {isTop && item.reason && (
      <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.4, color: 'var(--text-muted)' }}>{item.reason}</p>
    )}
    {isTop && (
      // Only under the picks. All ten titles carry a set of posts, and thirty
      // paragraphs is a wall, not a panel.
      <div className="social-grid">
        {[
          { label: 'X Post', text: item.post_for_x },
          { label: 'Reddit', text: item.post_for_reddit },
          { label: 'LinkedIn', text: item.post_for_linkedin },
        ].map((social) => (
          <div key={social.label} style={{ minWidth: 0 }}>
            <div style={{ ...labelStyle, marginBottom: 'var(--space-sm)' }}>{social.label}</div>
            <div style={{ fontSize: '0.8rem', lineHeight: 1.4 }}>
              {social.text || <span style={{ color: 'var(--text-muted)' }}>No post for this platform.</span>}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
);

const WritingPanelBody: React.FC<WritingPanelProps> = ({ projectId, videoMetadata, llmOutputs }) => {
  // Prompt-defined tasks have no bespoke view, so they are rendered
  // generically under the writing.
  const outputs = <LlmOutputs projectId={projectId} outputs={llmOutputs} />;

  const titles = videoMetadata?.components ?? [];
  // The prompt returns one summary for the video and it is copied onto every
  // title, so the first one that has it is the description.
  const description = titles.find((item) => item.summary)?.summary ?? '';

  // By position in the list, which is what the prompt's `index` refers to.
  const topPicks = new Set(
    (videoMetadata?.top_recommendations ?? [])
      .map((entry) => entry?.index)
      .filter((index): index is number => typeof index === 'number')
  );

  if (titles.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {/* An empty panel should say which step fills it, not just that it
            is empty. */}
        <div style={{ padding: 'var(--space-md)', color: 'var(--text-muted)' }}>
          No writing yet. Run the Metadata step to get titles and a description for the video.
        </div>
        {outputs}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-main)' }}>Video writing</h2>

      {description && (
        <div style={cardStyle}>
          <div style={labelStyle}>Description</div>
          <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5 }}>{description}</p>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-sm)' }}>
          <div style={labelStyle}>Titles</div>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{titles.length}</span>
        </div>
        {titles.map((item, position) => (
          <TitleRow
            key={`${position}-${item.title}`}
            item={item}
            position={position}
            isTop={topPicks.has(position) || topPicks.has(item.index)}
          />
        ))}
      </div>

      {outputs}
    </div>
  );
};

/**
 * Memoised because the page around it re-renders twice a second for as long as
 * a step is running, and this writing changes a handful of times per project.
 */
export const WritingPanel = React.memo(WritingPanelBody);
