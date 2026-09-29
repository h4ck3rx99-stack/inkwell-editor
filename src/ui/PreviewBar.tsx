'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/lib/store';
import type { EditorSession } from '@/editor/session';
import { placeNear } from './position';
import { useModKey } from './hooks';

/** Accept / Discard / Retry for an inline AI preview, anchored to the ghost text. */
export function PreviewBar({ session }: { session: EditorSession }) {
  const preview = useStore(session.state, (s) => s.preview);
  const mod = useModKey();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!preview) return;
    const el = ref.current;
    const anchor = session.editor.view.dom.querySelector(`[data-preview-id="${preview.id}"]`);
    if (!el || !anchor) return;
    const rects = anchor.getClientRects();
    const last = rects[rects.length - 1] ?? anchor.getBoundingClientRect();
    const p = placeNear(last, { width: el.offsetWidth, height: el.offsetHeight }, { gap: 10 });
    setPos({ top: p.top, left: p.left });
  }, [preview, session]);

  if (!preview) return null;
  const busy = preview.status === 'streaming';

  return createPortal(
    <div
      ref={ref}
      className="ink-preview-bar"
      role="toolbar"
      aria-label={`${preview.label} preview`}
      data-testid="preview-bar"
      data-status={preview.status}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="ink-preview-bar__label">{preview.label}</span>
      <span className="ink-preview-bar__status" role="status" aria-live="polite">
        {busy ? 'Writing…' : preview.status === 'error' ? preview.error : preview.kind === 'continue' ? `Tab to accept` : `${mod}+↵ to accept`}
      </span>
      {preview.status === 'done' && (
        <button type="button" className="ink-btn ink-btn--primary" onClick={() => session.acceptPreview()} data-testid="preview-accept">
          Accept
        </button>
      )}
      {preview.status !== 'streaming' && (
        <button type="button" className="ink-btn" onClick={() => session.retryPreview()} data-testid="preview-retry">
          Retry
        </button>
      )}
      <button type="button" className="ink-btn ink-btn--quiet" onClick={() => session.discardPreview()} data-testid="preview-discard">
        {busy ? 'Stop' : 'Discard'}
      </button>
    </div>,
    document.body,
  );
}
