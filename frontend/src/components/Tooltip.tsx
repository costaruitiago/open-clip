import React, { useEffect, useState } from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
}

/**
 * Hover/focus label for an icon-only control.
 *
 * The wrapped control is expected to carry its own `aria-label` — this is a
 * visual aid, not the accessible name, and it is deliberately `aria-hidden` so
 * a screen reader does not read the same string twice. What it must not be is
 * mouse-only: an icon button whose meaning only appears on hover is unusable
 * for anyone driving the page from the keyboard.
 */
export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  const [show, setShow] = useState(false);

  // WCAG 1.4.13 wants content shown on hover or focus to be dismissible
  // without moving the pointer or the focus.
  useEffect(() => {
    if (!show) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShow(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [show]);

  return (
    <div
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      // Focus moves to the button inside, so these have to be the bubbling
      // variants rather than onFocus/onBlur on the button itself.
      onFocusCapture={() => setShow(true)}
      onBlurCapture={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
            padding: '4px 8px',
            background: 'var(--text)',
            color: 'var(--bg)',
            fontSize: '0.75rem',
            fontWeight: 500,
            // Long labels used to force the row wider instead of wrapping.
            maxWidth: 'min(16rem, 60vw)',
            width: 'max-content',
            zIndex: 1000,
            pointerEvents: 'none',
            boxShadow: 'var(--shadow-float)',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
};
