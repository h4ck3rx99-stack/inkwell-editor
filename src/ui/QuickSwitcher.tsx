'use client';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import type { SearchResult } from '@/storage/types';
import type { AppController } from './app-controller';
import { Dialog } from './Dialog';
import { relativeTime } from './hooks';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function QuickSwitcher({ app }: { app: AppController }) {
  const open = useStore(app.state, (s) => s.dialog === 'switcher');
  return (
    <Dialog open={open} onClose={() => app.closeDialog()} title="Jump to a document or command" hideTitle className="ink-switcher" initialFocus="input">
      {open && <SwitcherBody app={app} />}
    </Dialog>
  );
}

function SwitcherBody({ app }: { app: AppController }) {
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const focusMode = useStore(app.state, (s) => s.focusMode);
  const theme = useStore(app.state, (s) => s.settings.theme);

  useEffect(() => {
    let cancelled = false;
    void app.search(query).then((r) => {
      if (!cancelled) {
        setDocs(r.slice(0, 8));
        setActive(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query, app]);

  const commands: Command[] = useMemo(
    () => [
      { id: 'new', label: 'New document', run: () => void app.createDocument() },
      { id: 'focus', label: focusMode ? 'Exit focus mode' : 'Enter focus mode', run: () => app.toggleFocusMode() },
      { id: 'issues', label: 'Toggle suggestions panel', run: () => app.togglePanel('issues') },
      { id: 'summarize', label: 'Summarize document', run: () => void app.summarize() },
      { id: 'continue', label: 'Continue writing at cursor', run: () => void app.session?.continueWriting() },
      { id: 'next', label: 'Next suggestion', run: () => app.session?.jump(1) },
      { id: 'theme', label: theme === 'dark' ? 'Use light theme' : 'Use night ink (dark) theme', run: () => void app.updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'settings', label: 'Settings', run: () => app.openDialog('settings') },
      { id: 'shortcuts', label: 'Keyboard shortcuts', run: () => app.openDialog('shortcuts') },
    ],
    [app, focusMode, theme],
  );

  const q = query.trim().toLowerCase();
  const matchedCommands = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands.slice(0, 4);
  const items: { key: string; label: string; meta: string; run: () => void }[] = [
    ...docs.map((d) => ({
      key: `d:${d.id}`,
      label: d.title || 'Untitled',
      meta: d.snippet || relativeTime(d.updatedAt),
      run: () => void app.openDocument(d.id),
    })),
    ...matchedCommands.map((c) => ({ key: `c:${c.id}`, label: c.label, meta: 'Command', run: c.run })),
  ];

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    app.closeDialog();
    item.run();
  };

  return (
    <div className="ink-switcher__body">
      <input
        className="ink-switcher__input"
        role="combobox"
        aria-expanded="true"
        aria-controls="switcher-list"
        aria-activedescendant={items[active] ? `sw-${active}` : undefined}
        aria-label="Search documents and commands"
        placeholder="Search documents or type a command"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(active);
          }
        }}
        data-testid="switcher-input"
      />
      <ul id="switcher-list" role="listbox" className="ink-switcher__list" aria-label="Results">
        {items.length === 0 && <li className="ink-switcher__empty">Nothing matches “{query}”.</li>}
        {items.map((item, i) => (
          <li
            key={item.key}
            id={`sw-${i}`}
            role="option"
            aria-selected={i === active}
            className={`ink-switcher__item${i === active ? ' is-active' : ''}`}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span className="ink-switcher__label">{item.label}</span>
            <span className="ink-switcher__meta">{item.meta}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
