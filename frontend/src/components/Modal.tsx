import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Rendered against the bottom edge, outside the scrolling body. */
  footer?: React.ReactNode;
  /** What to focus on open. Defaults to the first focusable thing inside. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  maxWidth?: string;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A dialog shell: the scrim, the panel, and the keyboard contract.
 *
 * Everything here is about not losing the user — focus goes in on open, cannot
 * leave by Tab while it is open, and returns to whatever opened it on close.
 * Callers supply only content.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  onClose,
  children,
  footer,
  initialFocusRef,
  maxWidth = '520px',
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers pass `onClose` inline, so it is a new function on every render.
  // Depending on it re-ran the effect below on any re-render of the caller,
  // which pulled focus out of whatever field was being typed in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () =>
      // Disabled and hidden nodes match the selector but cannot take focus, so
      // trapping onto one silently breaks the cycle and lets Tab escape.
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (node) => !node.hasAttribute('disabled') && node.offsetParent !== null
      );

    (initialFocusRef?.current ?? focusables()[0] ?? panelRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, initialFocusRef]);

  if (!isOpen) return null;

  // Portalled to the body rather than rendered in place. `z-index` only orders
  // siblings within a stacking context, and this dialog is opened from inside
  // two of them: the sticky project aside, and the clip cards, which are
  // `position: relative` for their own overlays. From in there no z-index can
  // win against a positioned element later in the document — the dialog came
  // out underneath the clip grid.
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
        padding: 'var(--space-md)',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg)',
          color: 'var(--text)',
          border: 'var(--border)',
          boxShadow: '8px 8px 0px var(--accent)',
          width: '100%',
          maxWidth,
          // The panel, not the page, is what scrolls when the content is
          // taller than the viewport.
          maxHeight: 'calc(100vh - (2 * var(--space-md)))',
          display: 'flex',
          flexDirection: 'column',
          animation: 'entrance 300ms var(--ease-out-quart)',
        }}
      >
        <div style={{ padding: 'var(--space-md)', borderBottom: 'var(--border)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: '1.4rem', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0,
              minWidth: '44px',
              minHeight: '44px',
              border: 'none',
              background: 'transparent',
              color: 'var(--text)',
              cursor: 'pointer',
              fontWeight: 900,
              fontSize: '1rem',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 'var(--space-md)', overflowY: 'auto' }}>{children}</div>

        {footer && (
          <div style={{ padding: 'var(--space-md)', borderTop: 'var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
