'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { EditorSession } from '@/editor/session';
import type { DocumentRecord } from '@/storage/types';
import type { AppController } from './app-controller';
import { SuggestionCard } from './SuggestionCard';
import { SelectionMenu } from './SelectionMenu';
import { PreviewBar } from './PreviewBar';
import { StatusLine } from './StatusLine';

function TitleInput({ app, record, session }: { app: AppController; record: DocumentRecord; session: EditorSession | null }) {
  const [title, setTitle] = useState(record.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = '0px';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // Re-fit when the column width changes (panels, sidebar, window) or web fonts load.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [title]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void app.renameDocument(record.id, value.trim()), 350);
  };

  return (
    <textarea
      ref={ref}
      className="ink-title"
      rows={1}
      value={title}
      placeholder="Untitled"
      aria-label="Document title"
      data-testid="doc-title"
      spellCheck={false}
      maxLength={200}
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, ' ');
        setTitle(v);
        commit(v);
      }}
      onBlur={() => {
        if (timer.current) {
          clearTimeout(timer.current);
          void app.renameDocument(record.id, title.trim());
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionStart === title.length)) {
          e.preventDefault();
          session?.editor.chain().focus('start').run();
        }
      }}
    />
  );
}

export function EditorPane({ app, docId, epoch }: { app: AppController; docId: string; epoch: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [record, setRecord] = useState<DocumentRecord | null>(null);
  const [session, setSession] = useState<EditorSession | null>(null);
  const [missing, setMissing] = useState(false);
  const conflict = useStore(app.state, (s) => s.conflict);
  const removed = useStore(app.state, (s) => s.removedInOtherTab);

  useEffect(() => {
    let disposed = false;
    let created: EditorSession | null = null;
    void (async () => {
      const rec = await app.docs.get(docId);
      if (disposed) return;
      if (!rec || rec.deletedAt !== null) {
        setMissing(true);
        return;
      }
      setRecord(rec);
      const mount = mountRef.current;
      const scroll = scrollRef.current;
      if (!mount || !scroll || !app.local) return;
      mount.replaceChildren();
      created = new EditorSession(rec, mount, scroll, app.sessionEnv());
      app.attachSession(created);
      setSession(created);
    })();
    return () => {
      disposed = true;
      if (created) {
        if (app.session === created) app.attachSession(null);
        void created.dispose();
      }
    };
  }, [app, docId, epoch]);

  if (missing) {
    return (
      <div className="ink-scroll">
        <div className="ink-page ink-empty">
          <p>This document is no longer available.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {conflict && (
        <div className="ink-banner" role="alert">
          <span>This document was changed in another tab.</span>
          <button type="button" className="ink-btn" onClick={() => void app.resolveConflict('theirs')}>Load that version</button>
          <button type="button" className="ink-btn ink-btn--quiet" onClick={() => void app.resolveConflict('mine')}>Keep mine</button>
        </div>
      )}
      {removed && (
        <div className="ink-banner" role="alert">
          <span>This document was deleted in another tab.</span>
          <button type="button" className="ink-btn" onClick={() => void app.restoreDocument(docId)}>Restore it</button>
        </div>
      )}
      <div className="ink-scroll" ref={scrollRef} data-testid="scroll-container">
        <article className="ink-page">
          {record && <TitleInput app={app} record={record} session={session} />}
          <div ref={mountRef} className="ink-editor-mount" />
        </article>
      </div>
      {session && (
        <>
          <StatusLine app={app} session={session} />
          <SuggestionCard session={session} />
          <SelectionMenu session={session} onExplain={() => void app.explainSelection()} onOpenSettings={() => app.openDialog('settings')} />
          <PreviewBar session={session} />
        </>
      )}
    </>
  );
}
