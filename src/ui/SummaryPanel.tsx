'use client';
import { useState } from 'react';
import { useStore } from '@/lib/store';
import type { AppController } from './app-controller';
import { IconClose } from './Icons';

function renderText(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^[-*•]\s+/.test(l))) {
    return (
      <ul className="ink-summary__list">
        {lines.map((l, i) => (
          <li key={i}>{l.replace(/^[-*•]\s+/, '')}</li>
        ))}
      </ul>
    );
  }
  return text.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>);
}

export function SummaryPanel({ app }: { app: AppController }) {
  const summary = useStore(app.state, (s) => s.summary);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      app.toast('Couldn’t copy to the clipboard.');
    }
  };

  return (
    <aside className="ink-panel" aria-labelledby="summary-title" aria-busy={summary.status === 'streaming'} data-testid="summary-panel">
      <header className="ink-panel__header">
        <h2 id="summary-title" className="ink-panel__title">{summary.title || 'Summary'}</h2>
        <button type="button" className="ink-icon-btn" onClick={() => app.closePanel()} aria-label="Close panel">
          <IconClose />
        </button>
      </header>
      <div className="ink-panel__body ink-summary" aria-live="polite">
        {summary.status === 'error' ? (
          <div className="ink-summary__error">
            <p>{summary.error}</p>
            <button type="button" className="ink-btn" onClick={() => app.retryPanel()}>
              Retry
            </button>
          </div>
        ) : summary.text ? (
          renderText(summary.text)
        ) : (
          <p className="ink-muted">{summary.status === 'streaming' ? 'Reading the document…' : 'Nothing here yet.'}</p>
        )}
      </div>
      {summary.status === 'done' && summary.text && (
        <footer className="ink-panel__footer">
          <button type="button" className="ink-btn" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {summary.kind === 'summary' && (
            <button type="button" className="ink-btn ink-btn--primary" onClick={() => app.session?.insertAtCursor(summary.text)} data-testid="summary-insert">
              Insert at cursor
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}
