/**
 * App-level state and actions: documents, settings, dictionary, panels,
 * dialogs, toasts and cross-tab coordination. The open document itself is an
 * EditorSession owned by <EditorPane>.
 */
import { createStore, type Store } from '@/lib/store';
import { makeId } from '@/lib/hash';
import { CircuitBreaker } from '@/lib/circuit-breaker';
import { debugLog } from '@/lib/debug-log';
import { LocalAnalyzerClient } from '@/analysis/local/client';
import { describeWriteError, fetchAIStatus, streamWrite } from '@/analysis/ai-client/client';
import type { AIStatus } from '@/shared/ai-contract';
import { DEFAULT_SETTINGS, normalizeDictionaryWord, type Settings } from '@/settings/model';
import { getStores } from '@/storage/indexeddb';
import { TabSync } from '@/storage/tab-sync';
import type { DocumentStore, DocumentSummary, SearchResult, SettingsStore } from '@/storage/types';
import type { EditorSession, SessionEnv } from '@/editor/session';
import { SAMPLE_DOCUMENT } from './sample';

export interface Toast {
  id: string;
  message: string;
  action?: { label: string; run: () => void };
  timeoutMs: number;
}

export type Panel = 'issues' | 'summary' | null;
export type Dialog = 'switcher' | 'settings' | 'shortcuts' | null;

export interface SummaryState {
  kind: 'summary' | 'explain';
  title: string;
  text: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  error?: string;
}

export interface AppState {
  ready: boolean;
  docs: DocumentSummary[];
  currentId: string | null;
  epoch: number;
  settings: Settings;
  dictionary: string[];
  aiStatus: AIStatus | null;
  sidebarOpen: boolean;
  panel: Panel;
  summary: SummaryState;
  focusMode: boolean;
  dialog: Dialog;
  toasts: Toast[];
  conflict: boolean;
  removedInOtherTab: boolean;
  storageError: string | null;
  /** Bumped when the open EditorSession changes, so React can re-read app.session. */
  sessionVersion: number;
}

const DELETE_UNDO_MS = 7000;

export class AppController {
  readonly state: Store<AppState>;
  readonly docs: DocumentStore;
  readonly settingsStore: SettingsStore;
  /** Recreated on every init() so a StrictMode unmount/remount leaves a live channel. */
  tabSync = new TabSync();
  readonly aiBreaker = new CircuitBreaker({ failureThreshold: 3, baseCooldownMs: 15_000, maxCooldownMs: 120_000 });
  local: LocalAnalyzerClient | null = null;
  session: EditorSession | null = null;
  private pendingPurges = new Map<string, ReturnType<typeof setTimeout>>();
  private summaryAbort: AbortController | null = null;
  private cleanup: (() => void)[] = [];

  constructor() {
    const stores = getStores();
    this.docs = stores.docs;
    this.settingsStore = stores.settings;
    this.state = createStore<AppState>({
      ready: false,
      docs: [],
      currentId: null,
      epoch: 0,
      settings: DEFAULT_SETTINGS,
      dictionary: [],
      aiStatus: null,
      sidebarOpen: true,
      panel: null,
      summary: { kind: 'summary', title: '', text: '', status: 'idle' },
      focusMode: false,
      dialog: null,
      toasts: [],
      conflict: false,
      removedInOtherTab: false,
      storageError: null,
      sessionVersion: 0,
    });
  }

  async init(): Promise<void> {
    this.tabSync.close();
    this.tabSync = new TabSync();
    this.local?.dispose();
    this.local = new LocalAnalyzerClient();
    try {
      const [settings, dictionary, lastId] = await Promise.all([
        this.settingsStore.getSettings(),
        this.settingsStore.getDictionary(),
        this.settingsStore.getLastDocumentId(),
      ]);
      await this.docs.purgeDeleted(60 * 60_000).catch(() => 0);
      const docs = await this.docs.list();
      const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches;
      this.state.set({
        settings, dictionary, docs,
        panel: settings.showIssuesPanel && !narrow ? 'issues' : null,
        sidebarOpen: !narrow,
      });
      this.applyTheme(settings);
      this.local?.configure(settings.dialect, dictionary);
      const initial = lastId && docs.some((d) => d.id === lastId) ? lastId : (docs[0]?.id ?? null);
      this.state.set({ currentId: initial, ready: true });
    } catch (err) {
      this.state.set({ ready: true, storageError: 'Inkwell couldn’t open local storage in this browser. Your writing can’t be saved here.' });
      debugLog('storage.error', { error: String(err) });
    }
    this.cleanup.push(this.tabSync.subscribe((m) => void this.onTabMessage(m)));
    void this.refreshAIStatus();
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.tabSync.close();
    this.local?.dispose();
    this.local = null;
  }

  async refreshAIStatus(): Promise<void> {
    try {
      const status = await fetchAIStatus();
      this.state.set({ aiStatus: status });
    } catch {
      this.state.set({ aiStatus: { provider: 'none', configured: false, label: 'None', fastModel: null, qualityModel: null, reason: 'The AI service could not be reached.' } });
    }
    this.session?.refreshAIMode();
  }

  sessionEnv(): SessionEnv {
    return {
      store: this.docs,
      tabSync: this.tabSync,
      local: this.local!,
      aiBreaker: this.aiBreaker,
      getSettings: () => this.state.get().settings,
      getDictionary: () => this.state.get().dictionary,
      addToDictionary: (w) => void this.addToDictionary(w),
      getAIStatus: () => this.state.get().aiStatus,
      onSaved: ({ id, wordCount, updatedAt }) =>
        this.state.set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, wordCount, updatedAt } : d)) })),
      notify: (message, action) => this.toast(message, action),
    };
  }

  attachSession(session: EditorSession | null): void {
    this.session = session;
    if (session) session.setFocusMode(this.state.get().focusMode);
    this.state.set((s) => ({ sessionVersion: s.sessionVersion + 1 }));
  }

  // ── documents ─────────────────────────────────────────────────────────────

  async refreshDocs(): Promise<void> {
    this.state.set({ docs: await this.docs.list() });
  }

  async createDocument(opts: { sample?: boolean } = {}): Promise<void> {
    const doc = await this.docs.create(opts.sample ? SAMPLE_DOCUMENT : {});
    this.tabSync.post({ type: 'created', docId: doc.id });
    await this.refreshDocs();
    await this.openDocument(doc.id);
    if (window.matchMedia('(max-width: 899px)').matches) this.state.set({ sidebarOpen: false });
  }

  async openDocument(id: string): Promise<void> {
    if (this.state.get().currentId === id) return;
    await this.session?.flush().catch(() => {});
    this.summaryAbort?.abort();
    this.state.set({ currentId: id, conflict: false, removedInOtherTab: false, dialog: null, summary: { kind: 'summary', title: '', text: '', status: 'idle' }, panel: this.state.get().panel === 'summary' ? null : this.state.get().panel });
    await this.settingsStore.setLastDocumentId(id);
    if (window.matchMedia('(max-width: 899px)').matches) this.state.set({ sidebarOpen: false });
  }

  async renameDocument(id: string, title: string): Promise<void> {
    if (this.session?.doc.id === id) this.session.setTitle(title);
    else {
      await this.docs.updateMeta(id, { title });
      this.tabSync.post({ type: 'meta', docId: id });
    }
    this.state.set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, title, updatedAt: Date.now() } : d)) }));
  }

  async deleteDocument(id: string): Promise<void> {
    const docs = this.state.get().docs;
    const doc = docs.find((d) => d.id === id);
    await this.docs.softDelete(id);
    this.tabSync.post({ type: 'deleted', docId: id });
    const remaining = docs.filter((d) => d.id !== id);
    this.state.set({ docs: remaining });
    if (this.state.get().currentId === id) {
      const next = remaining[0]?.id ?? null;
      this.state.set({ currentId: next });
      await this.settingsStore.setLastDocumentId(next);
    }
    const timer = setTimeout(() => {
      this.pendingPurges.delete(id);
      void this.docs.purge(id);
    }, DELETE_UNDO_MS + 500);
    this.pendingPurges.set(id, timer);
    this.toast(`Deleted “${doc?.title || 'Untitled'}”`, { label: 'Undo', run: () => void this.restoreDocument(id) }, DELETE_UNDO_MS);
  }

  async restoreDocument(id: string): Promise<void> {
    const t = this.pendingPurges.get(id);
    if (t) clearTimeout(t);
    this.pendingPurges.delete(id);
    await this.docs.restore(id);
    this.tabSync.post({ type: 'restored', docId: id });
    await this.refreshDocs();
    await this.openDocument(id);
  }

  search(query: string): Promise<SearchResult[]> {
    return this.docs.search(query);
  }

  // ── settings & dictionary ─────────────────────────────────────────────────

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const prev = this.state.get().settings;
    const next = { ...prev, ...patch, categories: { ...prev.categories, ...(patch.categories ?? {}) } };
    this.state.set({ settings: next });
    this.applyTheme(next);
    if (prev.dialect !== next.dialect) this.local?.configure(next.dialect, this.state.get().dictionary);
    this.session?.settingsChanged(prev, next);
    await this.settingsStore.setSettings(next);
    this.tabSync.post({ type: 'settings' });
  }

  async addToDictionary(word: string): Promise<void> {
    const w = normalizeDictionaryWord(word);
    if (!w) return;
    const dictionary = [...new Set([...this.state.get().dictionary, w])].sort();
    this.state.set({ dictionary });
    this.local?.configure(this.state.get().settings.dialect, dictionary);
    this.session?.dictionaryChanged();
    await this.settingsStore.setDictionary(dictionary);
    this.tabSync.post({ type: 'settings' });
  }

  async removeFromDictionary(word: string): Promise<void> {
    const dictionary = this.state.get().dictionary.filter((w) => w !== word);
    this.state.set({ dictionary });
    this.local?.configure(this.state.get().settings.dialect, dictionary);
    this.session?.recheckLocal();
    await this.settingsStore.setDictionary(dictionary);
    this.tabSync.post({ type: 'settings' });
  }

  applyTheme(settings: Settings): void {
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }

  // ── chrome ────────────────────────────────────────────────────────────────

  toggleSidebar(open?: boolean): void {
    this.state.set((s) => ({ sidebarOpen: open ?? !s.sidebarOpen }));
  }

  togglePanel(panel: Exclude<Panel, null>): void {
    const next = this.state.get().panel === panel ? null : panel;
    this.state.set({ panel: next });
    if (panel === 'issues') void this.updateSettings({ showIssuesPanel: next === 'issues' });
  }

  closePanel(): void {
    if (this.state.get().panel === 'summary') this.summaryAbort?.abort();
    this.state.set({ panel: null });
  }

  toggleFocusMode(on?: boolean): void {
    const focusMode = on ?? !this.state.get().focusMode;
    this.state.set({ focusMode });
    document.documentElement.dataset.focus = focusMode ? 'on' : 'off';
    this.session?.setFocusMode(focusMode);
  }

  openDialog(dialog: Dialog): void {
    this.state.set({ dialog });
  }

  closeDialog(): void {
    this.state.set({ dialog: null });
    requestAnimationFrame(() => this.session?.editor.view.focus());
  }

  toast(message: string, action?: Toast['action'], timeoutMs = 4500): void {
    const t: Toast = { id: makeId('n'), message, action, timeoutMs };
    this.state.set((s) => ({ toasts: [...s.toasts.slice(-2), t] }));
  }

  dismissToast(id: string): void {
    this.state.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  // ── side-panel AI actions ─────────────────────────────────────────────────

  async summarize(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!session.aiWritingAvailable()) {
      this.toast(session.aiUnavailableMessage());
      return;
    }
    const text = session.documentText();
    if (text.trim().split(/\s+/).length < 20) {
      this.toast('There isn’t enough here to summarize yet.');
      return;
    }
    await this.streamToPanel('summary', 'Summary', { action: 'summarize', text });
  }

  async explainSelection(): Promise<void> {
    const session = this.session;
    const sel = session?.selectionText();
    if (!session || !sel) return;
    if (!session.aiWritingAvailable()) {
      this.toast(session.aiUnavailableMessage());
      return;
    }
    session.closeSelectionMenu();
    await this.streamToPanel('explain', 'Explanation', { action: 'explain', text: sel.text, before: sel.before, after: sel.after });
  }

  private lastPanelRequest: { kind: SummaryState['kind']; title: string; req: { action: 'summarize' | 'explain'; text: string; before?: string; after?: string } } | null = null;

  retryPanel(): void {
    const r = this.lastPanelRequest;
    if (r) void this.streamToPanel(r.kind, r.title, r.req);
  }

  private async streamToPanel(kind: SummaryState['kind'], title: string, req: { action: 'summarize' | 'explain'; text: string; before?: string; after?: string }) {
    this.summaryAbort?.abort();
    const controller = new AbortController();
    this.summaryAbort = controller;
    this.lastPanelRequest = { kind, title, req };
    const settings = this.state.get().settings;
    const goal = this.session?.doc.settings.goal ?? 'general';
    this.state.set({ panel: 'summary', summary: { kind, title, text: '', status: 'streaming' } });
    try {
      const full = await streamWrite({ ...req, dialect: settings.dialect, goal }, controller.signal, {
        onText: (text) => this.state.set({ summary: { kind, title, text, status: 'streaming' } }),
      });
      this.state.set({ summary: { kind, title, text: full.trim(), status: 'done' } });
    } catch (err) {
      if (controller.signal.aborted) return;
      this.state.set({ summary: { kind, title, text: '', status: 'error', error: describeWriteError(err) } });
    }
  }

  // ── cross-tab ─────────────────────────────────────────────────────────────

  async resolveConflict(choice: 'theirs' | 'mine'): Promise<void> {
    if (choice === 'mine') await this.session?.keepMine();
    else this.state.set((s) => ({ epoch: s.epoch + 1 }));
    this.state.set({ conflict: false });
  }

  private async onTabMessage(m: Parameters<Parameters<TabSync['subscribe']>[0]>[0]): Promise<void> {
    const current = this.state.get().currentId;
    switch (m.type) {
      case 'saved':
        if (m.docId === current && this.session) {
          const action = this.session.externalSave(m.version);
          if (action === 'reload') this.state.set((s) => ({ epoch: s.epoch + 1 }));
          else if (action === 'conflict') this.state.set({ conflict: true });
        }
        await this.refreshDocs();
        break;
      case 'deleted':
        await this.refreshDocs();
        if (m.docId === current) this.state.set({ removedInOtherTab: true });
        break;
      case 'meta':
      case 'created':
      case 'restored':
        await this.refreshDocs();
        break;
      case 'settings': {
        const [settings, dictionary] = await Promise.all([this.settingsStore.getSettings(), this.settingsStore.getDictionary()]);
        const prev = this.state.get().settings;
        this.state.set({ settings, dictionary });
        this.applyTheme(settings);
        this.local?.configure(settings.dialect, dictionary);
        this.session?.settingsChanged(prev, settings);
        this.session?.dictionaryChanged();
        break;
      }
    }
  }
}
