'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from './Icons';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Visually hide the title (still used as the accessible name). */
  hideTitle?: boolean;
  className?: string;
  children: ReactNode;
  initialFocus?: string;
}

/** Modal dialog on the native <dialog> element: focus trapping, Esc and inert background for free. */
export function Dialog({ open, onClose, title, hideTitle, className, children, initialFocus }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      const target = initialFocus ? el.querySelector<HTMLElement>(initialFocus) : null;
      target?.focus();
    } else if (!open && el.open) el.close();
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      className={`ink-dialog ${className ?? ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="ink-dialog__body">
          <header className="ink-dialog__header">
            <h2 id={titleId} className={hideTitle ? 'sr-only' : 'ink-dialog__title'}>
              {title}
            </h2>
            {!hideTitle && (
              <button type="button" className="ink-icon-btn" onClick={onClose} aria-label="Close">
                <IconClose />
              </button>
            )}
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
