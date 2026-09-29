'use client';
import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import type { SearchResult } from '@/storage/types';
import type { AppController } from './app-controller';
import { IconPlus, IconSearch, IconTrash, IconSidebar } from './Icons';
import { NARROW_QUERY, relativeTime, useMediaQuery, useModKey } from './hooks';

export function Sidebar({ app }: { app: AppController }) {
  const docs = useStore(app.state, (s) => s.docs);
  const currentId = useStore(app.state, (s) => s.currentId);
  const open = useStore(app.state, (s) => s.sidebarOpen);
  const narrow = useMediaQuery(NARROW_QUERY);
  const mod = useModKey();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);

  useEffect(() => {
    if (!query.trim()) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void app.search(query).then((r) => {
        if (!cancelled) setResults(r);
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, app, docs]);

  const list = query.trim() ? (results ?? []) : docs.map((d) => ({ ...d, snippet: '', matchedTitle: false }));

  return (
    <>
      {narrow && open && <div className="ink-scrim" onClick={() => app.toggleSidebar(false)} aria-hidden="true" />}
      <nav
        className={`ink-sidebar${open ? ' is-open' : ''}`}
        aria-label="Documents"
        data-testid="sidebar"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="ink-sidebar__top">
          <span className="ink-wordmark">Inkwell</span>
          <button type="button" className="ink-icon-btn" onClick={() => app.toggleSidebar(false)} aria-label="Hide sidebar" title={`Hide sidebar (${mod}+\\)`}>
            <IconSidebar />
          </button>
        </div>
        <button type="button" className="ink-new-doc" onClick={() => void app.createDocument()} data-testid="new-document">
          <IconPlus /> New document
        </button>
        <label className="ink-search">
          <IconSearch />
          <span className="sr-only">Search documents</span>
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            data-testid="doc-search"
          />
        </label>
        <div className="ink-doclist" role="list">
          {list.length === 0 && (
            <p className="ink-doclist__empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'No documents yet.'}</p>
          )}
          {list.map((d) => (
            <div key={d.id} role="listitem" className={`ink-docitem${d.id === currentId ? ' is-current' : ''}`}>
              <button
                type="button"
                className="ink-docitem__open"
                onClick={() => void app.openDocument(d.id)}
                aria-current={d.id === currentId ? 'page' : undefined}
                data-testid="doc-item"
              >
                <span className="ink-docitem__title">{d.title || 'Untitled'}</span>
                <span className="ink-docitem__meta">
                  {d.snippet ? d.snippet : `${relativeTime(d.updatedAt)} · ${d.wordCount.toLocaleString()} words`}
                </span>
              </button>
              <button
                type="button"
                className="ink-icon-btn ink-docitem__delete"
                aria-label={`Delete ${d.title || 'Untitled'}`}
                onClick={() => void app.deleteDocument(d.id)}
                data-testid="doc-delete"
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
        <div className="ink-sidebar__foot">
          <button type="button" className="ink-link" onClick={() => app.openDialog('switcher')}>
            Jump to… <kbd>{mod}</kbd>
            <kbd>K</kbd>
          </button>
        </div>
      </nav>
    </>
  );
}
