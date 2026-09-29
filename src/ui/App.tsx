'use client';
import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { AppController } from './app-controller';
import { Sidebar } from './Sidebar';
import { EditorPane } from './EditorPane';
import { Welcome } from './Welcome';
import { IssuesPanel } from './IssuesPanel';
import { SummaryPanel } from './SummaryPanel';
import { QuickSwitcher } from './QuickSwitcher';
import { SettingsDialog } from './SettingsDialog';
import { ShortcutsSheet } from './ShortcutsSheet';
import { Toasts } from './Toasts';
import { IconFocus, IconList, IconSettings, IconSidebar, IconCommand } from './Icons';
import { useModKey } from './hooks';
import { installDebugHooks } from './debug-hooks';

/** App-wide shortcuts. Chosen to avoid browser/OS collisions; matched on event.code so layouts and Alt characters don't matter. */
function useGlobalShortcuts(app: AppController) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.code === 'KeyP')) {
        e.preventDefault();
        app.openDialog(app.state.get().dialog === 'switcher' ? null : 'switcher');
      } else if (mod && !e.altKey && e.code === 'Backslash') {
        e.preventDefault();
        app.toggleSidebar();
      } else if (mod && !e.altKey && (e.code === 'Slash' || e.key === '/')) {
        e.preventDefault();
        app.openDialog(app.state.get().dialog === 'shortcuts' ? null : 'shortcuts');
      } else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyL') {
        e.preventDefault();
        app.togglePanel('issues');
      } else if (mod && e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        app.toggleFocusMode();
      } else if (mod && e.altKey && e.code === 'KeyN') {
        e.preventDefault();
        void app.createDocument();
      } else if (e.key === 'Escape' && !e.defaultPrevented && app.state.get().focusMode && !app.state.get().dialog) {
        app.toggleFocusMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);
}

function useLifecycleSaves(app: AppController) {
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void app.session?.flush();
    };
    const onBeforeUnload = () => {
      void app.session?.flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onBeforeUnload);
    };
  }, [app]);
}

export default function App() {
  const [app] = useState(() => new AppController());
  const ready = useStore(app.state, (s) => s.ready);
  const currentId = useStore(app.state, (s) => s.currentId);
  const epoch = useStore(app.state, (s) => s.epoch);
  const sidebarOpen = useStore(app.state, (s) => s.sidebarOpen);
  const panel = useStore(app.state, (s) => s.panel);
  const focusMode = useStore(app.state, (s) => s.focusMode);
  const storageError = useStore(app.state, (s) => s.storageError);
  useStore(app.state, (s) => s.sessionVersion);
  const mod = useModKey();

  useEffect(() => {
    void app.init();
    const uninstall = installDebugHooks(app);
    return () => {
      uninstall();
      app.dispose();
    };
  }, [app]);
  useGlobalShortcuts(app);
  useLifecycleSaves(app);

  if (!ready) return <div className="ink-app ink-app--loading" aria-busy="true" />;

  return (
    <div className={`ink-app${sidebarOpen ? ' has-sidebar' : ''}${panel ? ' has-panel' : ''}${focusMode ? ' is-focus' : ''}`} data-testid="app">
      <Sidebar app={app} />
      <main className="ink-main" aria-label="Editor">
        <header className="ink-topbar">
          {!sidebarOpen && (
            <button type="button" className="ink-icon-btn" onClick={() => app.toggleSidebar(true)} aria-label="Show documents" title={`Documents (${mod}+\\)`} data-testid="open-sidebar">
              <IconSidebar />
            </button>
          )}
          <span className="ink-topbar__spacer" />
          <button type="button" className="ink-icon-btn" onClick={() => app.openDialog('switcher')} aria-label="Jump to a document or command" title={`Jump to… (${mod}+K)`}>
            <IconCommand />
          </button>
          <button type="button" className="ink-icon-btn" onClick={() => app.togglePanel('issues')} aria-pressed={panel === 'issues'} aria-label="Suggestions panel" title={`Suggestions (${mod}+Shift+L)`} data-testid="toggle-issues">
            <IconList />
          </button>
          <button type="button" className="ink-icon-btn" onClick={() => app.toggleFocusMode()} aria-pressed={focusMode} aria-label="Focus mode" title="Focus mode">
            <IconFocus />
          </button>
          <button type="button" className="ink-icon-btn" onClick={() => app.openDialog('settings')} aria-label="Settings" title="Settings" data-testid="open-settings">
            <IconSettings />
          </button>
        </header>
        {storageError && (
          <div className="ink-banner" role="alert">
            {storageError}
          </div>
        )}
        {currentId ? <EditorPane key={`${currentId}:${epoch}`} app={app} docId={currentId} epoch={epoch} /> : <Welcome app={app} />}
      </main>
      {panel === 'issues' && <IssuesPanel session={app.session} onClose={() => app.closePanel()} />}
      {panel === 'summary' && <SummaryPanel app={app} />}
      <QuickSwitcher app={app} />
      <SettingsDialog app={app} />
      <ShortcutsSheet app={app} />
      <Toasts app={app} />
    </div>
  );
}
