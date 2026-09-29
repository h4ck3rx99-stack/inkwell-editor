'use client';
import { useStore } from '@/lib/store';
import type { AIMode, EditorSession } from '@/editor/session';
import type { SaveState } from '@/storage/autosave';
import type { AppController } from './app-controller';

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  unsaved: 'Saving…',
  saving: 'Saving…',
  retrying: 'Saving…',
  error: 'Not saved — retrying',
  conflict: 'Changed in another tab',
};

function aiLabel(mode: AIMode, provider: string): string {
  switch (mode) {
    case 'ai':
      return `AI checks · ${provider}`;
    case 'paused':
      return `AI paused · local checks on`;
    case 'offline':
      return 'Offline · local checks on';
    case 'doc-off':
      return 'Local checks only · AI off for this document';
    case 'not-configured':
    case 'local-only':
      return 'Local checks only';
  }
}

export function StatusLine({ app, session }: { app: AppController; session: EditorSession }) {
  const words = useStore(session.state, (s) => s.words);
  const minutes = useStore(session.state, (s) => s.readingMinutes);
  const count = useStore(session.state, (s) => s.suggestions.length);
  const save = useStore(session.state, (s) => s.saveState);
  const analyzing = useStore(session.state, (s) => s.analyzing);
  const aiMode = useStore(session.state, (s) => s.aiMode);
  const announcement = useStore(session.state, (s) => s.announcement);
  const provider = useStore(app.state, (s) => s.aiStatus?.label ?? '');
  const panel = useStore(app.state, (s) => s.panel);

  return (
    <footer className="ink-status" data-testid="status-line">
      <span>{words.toLocaleString()} {words === 1 ? 'word' : 'words'}</span>
      <span aria-hidden="true">·</span>
      <span>{minutes} min read</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="ink-status__btn" onClick={() => app.togglePanel('issues')} aria-pressed={panel === 'issues'} data-testid="issue-count">
        {count === 0 ? 'No suggestions' : `${count} ${count === 1 ? 'suggestion' : 'suggestions'}`}
      </button>
      <span className="ink-status__spacer" />
      <span className={`ink-status__save${save === 'error' || save === 'conflict' ? ' is-warn' : ''}`} data-testid="save-state" data-state={save}>
        {SAVE_LABEL[save]}
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" className="ink-status__btn ink-status__ai" onClick={() => app.openDialog('settings')} data-testid="ai-mode" data-mode={aiMode}>
        <span className={`ink-activity${analyzing ? ' is-on' : ''}`} aria-hidden="true" />
        {aiLabel(aiMode, provider)}
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </footer>
  );
}
