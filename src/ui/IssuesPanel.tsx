'use client';
import { useMemo, useRef } from 'react';
import { useStore } from '@/lib/store';
import type { EditorSession } from '@/editor/session';
import { CATEGORIES, CATEGORY_LABEL, type Category, type Suggestion } from '@/suggestions/model';
import { IconClose } from './Icons';

/**
 * Open suggestions grouped by category. Fully keyboard navigable and the
 * accessible interface to suggestions for screen-reader users.
 */
export function IssuesPanel({ session, onClose }: { session: EditorSession | null; onClose: () => void }) {
  return (
    <aside className="ink-panel" aria-labelledby="issues-title" data-testid="issues-panel">
      <header className="ink-panel__header">
        <h2 id="issues-title" className="ink-panel__title">Suggestions</h2>
        <button type="button" className="ink-icon-btn" onClick={onClose} aria-label="Close suggestions panel">
          <IconClose />
        </button>
      </header>
      {session ? <IssuesList session={session} /> : <p className="ink-panel__empty">Open a document to see suggestions.</p>}
    </aside>
  );
}

function IssuesList({ session }: { session: EditorSession }) {
  const suggestions = useStore(session.state, (s) => s.suggestions);
  const ignored = useStore(session.state, (s) => s.ignoredRules);
  const card = useStore(session.state, (s) => s.card);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const by = new Map<Category, Suggestion[]>();
    for (const s of suggestions) {
      const list = by.get(s.category) ?? [];
      list.push(s);
      by.set(s.category, list);
    }
    return CATEGORIES.filter((c) => by.has(c)).map((c) => ({ category: c, items: by.get(c)! }));
  }, [suggestions]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-issue]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <div className="ink-panel__body" ref={listRef} onKeyDown={onKeyDown}>
      {suggestions.length === 0 ? (
        <p className="ink-panel__empty">Nothing to flag right now. Keep writing.</p>
      ) : (
        groups.map((g) => (
          <section key={g.category} className="ink-issue-group" aria-label={`${CATEGORY_LABEL[g.category]}, ${g.items.length}`}>
            <h3 className="ink-issue-group__title">
              {CATEGORY_LABEL[g.category]} <span className="ink-count">{g.items.length}</span>
            </h3>
            <ul role="list">
              {g.items.map((s, idx) => (
                <li key={s.id}>
                  <button
                    type="button"
                    data-issue={s.id}
                    tabIndex={idx === 0 && g === groups[0] ? 0 : -1}
                    className={`ink-issue${card?.id === s.id ? ' is-active' : ''}`}
                    data-severity={s.severity}
                    onFocus={(e) => {
                      for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-issue]') ?? []) el.tabIndex = el === e.currentTarget ? 0 : -1;
                    }}
                    onClick={() => session.revealSuggestion(s.id, true, 'pinned')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.shiftKey && s.replacements.length) {
                        e.preventDefault();
                        session.accept(s.id, 0);
                      }
                    }}
                    aria-label={`${s.title}: “${s.original}”${s.replacements[0] !== undefined ? `, suggest “${s.replacements[0] || 'remove'}”` : ''}`}
                  >
                    <span className="ink-issue__dot" aria-hidden="true" />
                    <span className="ink-issue__text">
                      <span className="ink-issue__orig">{s.original.length > 48 ? `${s.original.slice(0, 46)}…` : s.original}</span>
                      {s.replacements[0] !== undefined && (
                        <>
                          <span className="ink-issue__arrow" aria-hidden="true"> → </span>
                          <span className="ink-issue__rep">{s.replacements[0] || 'remove'}</span>
                        </>
                      )}
                    </span>
                    <span className="ink-issue__title">{s.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {ignored.length > 0 && (
        <section className="ink-issue-group ink-issue-group--ignored">
          <h3 className="ink-issue-group__title">Ignored in this document</h3>
          <ul role="list">
            {ignored.map((r) => (
              <li key={r} className="ink-ignored">
                <span>{r.replace(/^(local|harper|ai):/, '').replace(/-/g, ' ')}</span>
                <button type="button" className="ink-link" onClick={() => session.restoreRule(r)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
