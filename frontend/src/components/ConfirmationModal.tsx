import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  /** A third, non-destructive way forward, shown between Cancel and Confirm. */
  alternative?: { text: string; onClick: () => void };
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'CONFIRM',
  cancelText = 'CANCEL',
  alternative,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Cancel is focused rather than Confirm: this dialog only ever guards a
    // destructive action, so the safe option should be the one a stray Enter
    // lands on.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;

      // Disabled and hidden nodes match the selector but cannot take focus, so
      // trapping onto one silently breaks the cycle and lets Tab escape the
      // dialog. `offsetParent` is null for anything display:none.
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  // Portalled for the same reason as Modal: this one is rendered from inside a
  // clip card, which is `position: relative`, so a confirmation opened on one
  // card would paint underneath the cards that follow it.
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg)',
          color: 'var(--text)',
          border: 'var(--border)',
          padding: 'var(--space-xl)',
          maxWidth: '500px',
          width: '90%',
          boxShadow: '8px 8px 0px var(--accent)',
          animation: 'entrance 300ms var(--ease-out-quart)'
        }}
      >
        <h2
          id={titleId}
          style={{
            fontSize: '2rem',
            fontWeight: '900',
            textTransform: 'uppercase',
            marginBottom: 'var(--space-md)',
            lineHeight: '1'
          }}
        >
          {title}
        </h2>
        <p style={{ 
          fontSize: '1.1rem', 
          fontWeight: 'bold', 
          marginBottom: 'var(--space-xl)',
          lineHeight: '1.4'
        }}>
          {message}
        </p>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
          gap: 'var(--space-md)'
        }}>
          {/* The design system's own button classes rather than inline hover
              handlers. Those set styles imperatively on mouseenter and undid
              them on mouseleave — an event a touch browser frequently never
              sends, which left the button stuck in its hover state. The
              classes carry the same treatment behind a (hover: hover) guard. */}
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="btn-ghost btn-md"
            style={{ fontSize: '0.9rem', minHeight: '44px' }}
          >
            {cancelText}
          </button>
          {alternative && (
            <button
              onClick={alternative.onClick}
              className="btn-ghost btn-md"
              style={{ fontSize: '0.9rem', minHeight: '44px' }}
            >
              {alternative.text}
            </button>
          )}
          <button
            onClick={onConfirm}
            className="btn-danger btn-md"
            style={{ fontSize: '0.9rem', minHeight: '44px' }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
