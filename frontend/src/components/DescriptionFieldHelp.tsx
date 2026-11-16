import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDescriptionFields } from '../api';

/**
 * The placeholders a description template may use.
 *
 * The list comes from the backend rather than being typed out here, because the
 * backend is what resolves them: a field that stops existing there has to stop
 * being advertised here on the same deploy.
 */
interface DescriptionFieldHelpProps {
  /**
   * Fields that exist only in the template being edited — `{platform.post}` in
   * a Postiz post, which has no meaning in a YouTube description. Listed after
   * the shared ones rather than in place of them.
   */
  extra?: { field: string; description: string }[];
}

export const DescriptionFieldHelp: React.FC<DescriptionFieldHelpProps> = ({ extra = [] }) => {
  const { data } = useQuery({ queryKey: ['descriptionFields'], queryFn: getDescriptionFields });

  const fields = [...extra, ...(data?.fields ?? [])];
  if (!fields.length) return null;

  return (
    <details style={{ fontSize: '0.75rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 500}}>
        Available fields
      </summary>
      <p style={{ margin: 'var(--space-sm) 0', color: 'var(--text-muted)', lineHeight: 1.4 }}>
        Anything you type is used exactly as written. A field in braces is replaced with its value,
        and a line whose fields are all empty is left out.
      </p>
      <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
        {fields.map((item) => (
          <div key={item.field} style={{ borderTop: 'var(--border)', paddingTop: 'var(--space-sm)' }}>
            <dt style={{ fontFamily: 'monospace', fontWeight: 500, overflowWrap: 'anywhere' }}>
              {`{${item.field}}`}
            </dt>
            <dd style={{ margin: 0, color: 'var(--text-muted)' }}>{item.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
};
