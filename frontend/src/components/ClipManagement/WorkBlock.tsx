import React, { useEffect, useRef, useState } from 'react';

interface WorkBlockProps {
  label: string;
  initialContent: string;
}

export const WorkBlock: React.FC<WorkBlockProps> = ({ label, initialContent }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const content = initialContent;

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async () => {
    try {
      // Absent over plain HTTP and rejected when the document is not focused,
      // so this is not a safe call to make bare. The unhandled rejection used
      // to leave the button claiming "Copied" with nothing on the clipboard.
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      console.warn('Clipboard write failed', err);
      setCopyState('failed');
    }
  };

  return (
    <div style={{ padding: 'var(--space-md)', border: 'var(--border)', borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
        <strong style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}>{label}</strong>
        <button
          onClick={handleCopy}
          className="btn-sm" style={{ minHeight: '32px', flexShrink: 0 }}
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      {copyState === 'failed' && (
        <p role="alert" style={{ margin: '0 0 var(--space-sm) 0', fontSize: '0.75rem', color: 'var(--error)' }}>
          Could not reach the clipboard. Select the text below and copy it manually.
        </p>
      )}
      <div style={{ padding: 'var(--space-sm)', fontSize: '0.85rem', lineHeight: '1.4' }}>
        {content}
      </div>
    </div>
  );
};
