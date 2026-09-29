/**
 * EditorSession: one open document. Owns the TipTap editor, the analysis
 * scheduler, and all suggestion / writing-action interactions. React never
 * re-renders on keystrokes: UI state is published through a throttled store.
 */
import type { Editor, JSONContent } from '@tiptap/core';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import type { EditorView } from '@tiptap/pm/view';
import { createStore, type Store } from '@/lib/store';
import { hashText, makeId } from '@/lib/hash';
import { countWords, readingTimeMinutes, type TextRange } from '@/lib/text';
import { debugLog } from '@/lib/debug-log';
import type { CircuitBreaker } from '@/lib/circuit-breaker';
import { AnalysisScheduler, type AIRequestInput, type SchedulerBlock } from '@/analysis/scheduler/scheduler';
import { AIRequestError } from '@/analysis/errors';
import type { LocalAnalyzerClient } from '@/analysis/local/client';
import { checkText, describeWriteError, streamWrite } from '@/analysis/ai-client/client';
import type { AIStatus, Tone, WriteAction } from '@/shared/ai-contract';
import {
  allBlocks, anchorFindings, blockAt, findBlock, leafText, textBetween, textOfBlock, verifySuggestion, type BlockRef,
} from '@/suggestions/anchor';
import { dismissKeys, isDismissed } from '@/suggestions/keys';
import { CATEGORIES, ruleKeyOf, type Finding, type Source, type Suggestion } from '@/suggestions/model';
import { CONFIDENCE_THRESHOLD, normalizeDictionaryWord, type DocSettings, type Settings } from '@/settings/model';
import { Autosaver, type SaveState } from '@/storage/autosave';
import type { DocumentRecord, DocumentStore } from '@/storage/types';
import type { TabSync } from '@/storage/tab-sync';
import { createInkwellEditor } from './create-editor';
import { displayedSuggestions, getSuggestionsState, suggestionsKey, type SuggestionsMeta } from './suggestions-plugin';
import { getPreview, previewKey, type Preview, type PreviewMeta } from './preview-plugin';
import { focusKey } from './focus-plugin';
import { assignBlockIds, blockIdKey } from './extensions/block-id';

export type CardMode = 'hover' | 'pinned' | 'keyboard';

export interface CardState {
  id: string;
  mode: CardMode;
  /** Bumped when the card should re-measure its anchor. */
  tick: number;
  why: { status: 'idle' | 'loading' | 'done' | 'error'; text: string };
}

export interface SelectionMenuState {
  from: number;
  to: number;
  /** Opened from the keyboard (focus the first item). */
  keyboard: boolean;
}

export type AIMode = 'ai' | 'local-only' | 'not-configured' | 'doc-off' | 'paused' | 'offline';

export interface SessionState {
  words: number;
  readingMinutes: number;
  suggestions: Suggestion[];
  analyzing: boolean;
  saveState: SaveState;
  card: CardState | null;
  selectionMenu: SelectionMenuState | null;
  preview: Preview | null;
  announcement: string;
  aiMode: AIMode;
  docSettings: DocSettings;
  ignoredRules: string[];
  engine: 'loading' | 'ready' | 'failed';
}

export interface SessionEnv {
  store: DocumentStore;
  tabSync: TabSync;
  local: LocalAnalyzerClient;
  aiBreaker: CircuitBreaker;
  getSettings(): Settings;
  getDictionary(): string[];
  addToDictionary(word: string): void;
  getAIStatus(): AIStatus | null;
  onSaved?(info: { id: string; wordCount: number; updatedAt: number }): void;
  onTitleFromContent?(): void;
  notify(message: string, action?: { label: string; run: () => void }): void;
}

interface RawResult {
  hash: string;
  findings: Finding[];
  revision: number;
}

interface AcceptRecord {
  blockId: string;
  original: string;
  replacement: string;
  at: number;
}

const HOVER_SHOW_MS = 320;
const HOVER_HIDE_MS = 260;
const SELECTION_SETTLE_MS = 380;
const PUBLISH_MS = 120;
const SENTENCE_END = /[.!?…]["'”’)\]]*[  ]$/;

export class EditorSession {
  readonly editor: Editor;
  readonly state: Store<SessionState>;
  readonly doc: { id: string; version: number; title: string; dismissed: Set<string>; ignoredRules: Set<string>; settings: DocSettings };

  private scheduler: AnalysisScheduler;
  private autosaver: Autosaver;
  private raw = new Map<string, RawResult>();
  private cursorSuppressedBlocks = new Set<string>();
  private suppressed = new Set<string>();
  private recentAccepts: AcceptRecord[] = [];
  private pendingWhileComposing = new Map<string, () => void>();
  private lastCursorBlock: string | null = null;
  private visibleCache: { at: number; ids: string[] } = { at: 0, ids: [] };
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private metaTimer: ReturnType<typeof setTimeout> | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private freshTimer: ReturnType<typeof setTimeout> | null = null;
  private previewAbort: AbortController | null = null;
  private whyAbort: AbortController | null = null;
  private lastPreviewRequest: { action: WriteAction; tone?: Tone; instruction?: string; label: string } | null = null;
  private lastSuggestionVersion = -1;
  private lastAnnouncedCount = -1;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private cleanup: (() => void)[] = [];
  private pointerDown = false;

  constructor(
    record: DocumentRecord,
    element: HTMLElement,
    private readonly scrollContainer: HTMLElement,
    private readonly env: SessionEnv,
  ) {
    this.doc = {
      id: record.id,
      version: record.version,
      title: record.title,
      dismissed: new Set(record.dismissed),
      ignoredRules: new Set(record.ignoredRules),
      settings: record.settings,
    };
    this.state = createStore<SessionState>({
      words: record.wordCount,
      readingMinutes: readingTimeMinutes(record.wordCount),
      suggestions: [],
      analyzing: false,
      saveState: 'saved',
      card: null,
      selectionMenu: null,
      preview: null,
      announcement: '',
      aiMode: 'local-only',
      docSettings: record.settings,
      ignoredRules: record.ignoredRules,
      engine: env.local.engineStatus,
    });

    this.editor = createInkwellEditor({
      element,
      content: (record.content as JSONContent) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
      callbacks: {
        onHover: (id, el) => this.onHover(id, el),
        onClick: (id) => this.openCard(id, 'pinned'),
        onKeyDown: (view, event) => this.onKeyDown(view, event),
      },
    });

    this.autosaver = new Autosaver({
      save: () => this.save(),
      onState: (s) => this.state.set({ saveState: s }),
    });

    this.scheduler = new AnalysisScheduler(
      {
        getBlock: (id) => this.schedulerBlock(id),
        getCursorBlockId: () => this.cursorBlockId(),
        getVisibleBlockIds: () => this.visibleBlockIds(),
        getAllBlockIds: () => allBlocks(this.editor.state.doc).map((b) => b.id),
        isComposing: () => this.editor.view.composing,
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
        aiAvailable: () => this.aiMode() === 'ai' || this.aiMode() === 'paused' || this.aiMode() === 'offline',
        aiSettingsKey: () => this.aiSettingsKey(),
        runLocal: (ids) => this.runLocal(ids),
        requestAI: (input, signal) => this.requestAI(input, signal),
        applyAI: (blockId, hash, findings, revision) => this.applyFindings(blockId, hash, findings, 'ai', revision),
        onStatus: (s) => this.state.set({ analyzing: s.localBusy || s.aiInFlight > 0 }),
        log: (event, data) => debugLog(event, { ...data, doc: this.doc.id }),
      },
      { breaker: env.aiBreaker },
    );

    this.editor.on('transaction', ({ transaction }) => this.onTransaction(transaction));
    this.editor.on('blur', () => void this.autosaver.flush());

    const onScroll = () => this.onScroll();
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });
    const onOnline = () => {
      this.refreshAIMode();
      this.scheduler.resume();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    const onPointerDown = () => {
      this.pointerDown = true;
    };
    const onPointerUp = () => {
      this.pointerDown = false;
      this.scheduleSelectionMenu();
    };
    element.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    const onCompositionEnd = () => {
      const pending = [...this.pendingWhileComposing.values()];
      this.pendingWhileComposing.clear();
      queueMicrotask(() => pending.forEach((fn) => fn()));
    };
    element.addEventListener('compositionend', onCompositionEnd);
    this.cleanup.push(
      () => scrollContainer.removeEventListener('scroll', onScroll),
      () => window.removeEventListener('online', onOnline),
      () => window.removeEventListener('offline', onOnline),
      () => element.removeEventListener('pointerdown', onPointerDown),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => element.removeEventListener('compositionend', onCompositionEnd),
      env.local.onEngineStatus((s) => {
        this.state.set({ engine: s });
        if (s === 'ready') this.scheduler.requestLocal(allBlocks(this.editor.state.doc).map((b) => b.id), true);
      }),
      env.aiBreaker.subscribe(() => this.refreshAIMode()),
    );

    // Blocks need ids before the first analysis pass (TipTap's onCreate fires asynchronously).
    const idTr = assignBlockIds(this.editor.state);
    if (idTr) this.editor.view.dispatch(idTr);
    this.restoreView(record);
    this.refreshAIMode();
    this.lastCursorBlock = this.cursorBlockId();
    this.scheduler.start();
    this.publishStats();
    debugLog('session.open', { doc: this.doc.id });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.autosaver.flush().catch(() => {});
    await this.persistViewState().catch(() => {});
    this.disposed = true;
    this.previewAbort?.abort();
    this.whyAbort?.abort();
    this.scheduler.dispose();
    this.autosaver.dispose();
    for (const t of [this.publishTimer, this.statsTimer, this.metaTimer, this.viewTimer, this.hoverTimer, this.selectionTimer, this.freshTimer, this.announceTimer]) {
      if (t) clearTimeout(t);
    }
    for (const fn of this.cleanup) fn();
    this.editor.destroy();
  }

  /** Flush pending saves (visibilitychange / beforeunload). */
  flush(): Promise<void> {
    void this.persistViewState();
    return this.autosaver.flush();
  }

  get hasUnsavedChanges(): boolean {
    return this.autosaver.hasUnsavedChanges;
  }

  // ── settings & modes ──────────────────────────────────────────────────────

  aiMode(): AIMode {
    const status = this.env.getAIStatus();
    const settings = this.env.getSettings();
    if (settings.localOnly) return 'local-only';
    if (!status || !status.configured) return 'not-configured';
    if (!this.doc.settings.aiEnabled) return 'doc-off';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (this.env.aiBreaker.state === 'open') return 'paused';
    return 'ai';
  }

  refreshAIMode(): void {
    const mode = this.aiMode();
    const prev = this.state.get().aiMode;
    this.state.set({ aiMode: mode });
    const aiOn = (m: AIMode) => m === 'ai' || m === 'paused' || m === 'offline';
    if (aiOn(prev) && !aiOn(mode)) {
      this.scheduler.cancelAI();
      this.dispatchMeta({ type: 'filter', keep: (s) => s.source !== 'ai' });
      for (const k of [...this.raw.keys()]) if (k.endsWith('|ai')) this.raw.delete(k);
    } else if (!aiOn(prev) && aiOn(mode)) {
      this.scheduler.invalidate({ local: false, ai: true });
    }
  }

  /** Global settings changed (categories, sensitivity, dialect, dictionary, local-only). */
  settingsChanged(prev: Settings, next: Settings): void {
    const dialectChanged = prev.dialect !== next.dialect;
    const sensitivityChanged = prev.sensitivity !== next.sensitivity;
    const categoriesChanged = CATEGORIES.some((c) => prev.categories[c] !== next.categories[c]);
    this.refreshAIMode();
    if (dialectChanged || sensitivityChanged || categoriesChanged) {
      this.reapplyRaw();
      this.scheduler.invalidate({ local: dialectChanged || sensitivityChanged, ai: true });
    }
    this.setFocusMode(document.documentElement.dataset.focus === 'on');
  }

  /** Re-run local checks everywhere (e.g. a word was removed from the dictionary). */
  recheckLocal(): void {
    this.scheduler.invalidate({ local: true, ai: false });
  }

  dictionaryChanged(): void {
    const dict = new Set(this.env.getDictionary());
    this.dispatchMeta({
      type: 'filter',
      keep: (s) => s.category !== 'spelling' || !dict.has(normalizeDictionaryWord(s.original)),
    });
  }

  updateDocSettings(patch: Partial<DocSettings>): void {
    const prev = this.doc.settings;
    this.doc.settings = { ...prev, ...patch };
    this.state.set({ docSettings: this.doc.settings });
    void this.env.store.updateMeta(this.doc.id, { settings: this.doc.settings });
    this.env.tabSync.post({ type: 'meta', docId: this.doc.id });
    if (prev.aiEnabled !== this.doc.settings.aiEnabled) this.refreshAIMode();
    if (prev.goal !== this.doc.settings.goal) this.scheduler.invalidate({ local: false, ai: true });
  }

  setFocusMode(enabled: boolean): void {
    const current = focusKey.getState(this.editor.state)?.enabled ?? false;
    if (current === enabled) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(focusKey, { enabled }).setMeta('addToHistory', false));
  }

  setTitle(title: string): void {
    this.doc.title = title;
    void this.env.store.updateMeta(this.doc.id, { title }).then(() => this.env.tabSync.post({ type: 'meta', docId: this.doc.id }));
  }

  private aiSettingsKey(): string {
    const s = this.env.getSettings();
    return [s.dialect, s.sensitivity, this.doc.settings.goal, CATEGORIES.filter((c) => s.categories[c]).join(',')].join('|');
  }

  // ── transactions ──────────────────────────────────────────────────────────

  private onTransaction(tr: Transaction): void {
    if (this.disposed) return;
    const state = this.editor.state;

    if (tr.docChanged) {
      const idsOnly = tr.getMeta(blockIdKey) === true;
      this.autosaver.markDirty();
      if (!idsOnly) {
        const dirty = this.changedBlockIds(tr);
        const cursorBlock = this.cursorBlockId();
        const sentenceCompleted = this.detectSentenceCompletion(tr, cursorBlock);
        this.scheduler.edit(dirty, { sentenceCompleted, cursorBlockId: cursorBlock });
        if (isHistoryTransaction(tr)) this.onUndoRedo();
        this.scheduleStats();
        if (this.state.get().selectionMenu) this.state.set({ selectionMenu: null });
      }
    }

    const ps = previewKey.getState(state);
    if (ps?.cancelledId) {
      this.previewAbort?.abort();
      this.previewAbort = null;
      debugLog('preview.cancelled', { id: ps.cancelledId });
    }
    if (ps?.preview !== this.state.get().preview) this.state.set({ preview: ps?.preview ?? null });

    if (tr.selectionSet || tr.docChanged) this.onSelectionMaybeChanged();

    const sugState = getSuggestionsState(state);
    if (sugState.fresh.size && !this.freshTimer) {
      this.freshTimer = setTimeout(() => {
        this.freshTimer = null;
        if (!this.disposed) this.dispatchMeta({ type: 'settleFresh' });
      }, 220);
    }
    if (sugState.version !== this.lastSuggestionVersion) {
      this.lastSuggestionVersion = sugState.version;
      this.schedulePublish();
      const card = this.state.get().card;
      if (card && !sugState.visible.has(card.id)) this.closeCard();
      else if (card) this.state.set({ card: { ...card, tick: card.tick + 1 } });
    }
  }

  private changedBlockIds(tr: Transaction): string[] {
    const ids = new Set<string>();
    const doc = tr.doc;
    tr.mapping.maps.forEach((map, i) => {
      map.forEach((_os, _oe, newStart, newEnd) => {
        // Map the step-local range forward to the final document.
        const rest = tr.mapping.slice(i + 1);
        const from = rest.map(newStart, -1);
        const to = rest.map(newEnd, 1);
        doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node) => {
          if (node.isTextblock) {
            const id = node.attrs.bid;
            if (typeof id === 'string') ids.add(id);
            return false;
          }
          return true;
        });
      });
    });
    return [...ids];
  }

  private detectSentenceCompletion(tr: Transaction, cursorBlock: string | null): boolean {
    if (!cursorBlock) return false;
    const { $head } = tr.selection;
    // Enter pressed: the previous block was completed.
    if ($head.parentOffset === 0) return true;
    const before = $head.parent.textBetween(Math.max(0, $head.parentOffset - 6), $head.parentOffset, undefined, leafText);
    return SENTENCE_END.test(before);
  }

  private onSelectionMaybeChanged(): void {
    const blockId = this.cursorBlockId();
    if (blockId !== this.lastCursorBlock) {
      const left = this.lastCursorBlock;
      this.lastCursorBlock = blockId;
      if (left && this.cursorSuppressedBlocks.has(left)) {
        this.cursorSuppressedBlocks.delete(left);
        this.scheduler.requestLocal([left], true);
      }
      this.scheduler.selectionChanged(blockId);
    } else if (blockId && this.cursorSuppressedBlocks.has(blockId)) {
      // A word the caret was touching may now be complete.
      this.scheduler.requestLocal([blockId]);
    }
    const card = this.state.get().card;
    if (card?.mode === 'keyboard') {
      const s = getSuggestionsState(this.editor.state).items.get(card.id);
      const head = this.editor.state.selection.head;
      if (!s || head < s.from || head > s.to) this.closeCard();
    }
    this.scheduleSelectionMenu();
    this.scheduleViewStateSave();
    if (this.env.getSettings().typewriterScrolling && document.documentElement.dataset.focus === 'on') this.typewriterScroll();
  }

  // ── blocks / scheduler host ───────────────────────────────────────────────

  private cursorBlockId(): string | null {
    return blockAt(this.editor.state.doc, this.editor.state.selection.head)?.id ?? null;
  }

  private schedulerBlock(id: string): SchedulerBlock | null {
    const doc = this.editor.state.doc;
    const b = findBlock(doc, id);
    if (!b) return null;
    const text = textOfBlock(b.node);
    let context = '';
    if (b.pos > 0) {
      const prev = blockAt(doc, b.pos - 1);
      if (prev) context = textOfBlock(prev.node).slice(-400);
    }
    return { text, hash: hashText(text), context, revision: getSuggestionsState(this.editor.state).revision };
  }

  private codeRanges(b: BlockRef): TextRange[] {
    const out: TextRange[] = [];
    const codeType = this.editor.schema.marks.code;
    b.node.forEach((child, offset) => {
      if (child.isText && codeType && child.marks.some((m) => m.type === codeType)) out.push({ start: offset, end: offset + child.nodeSize });
    });
    return out;
  }

  private visibleBlockIds(): string[] {
    const now = Date.now();
    if (now - this.visibleCache.at < 150) return this.visibleCache.ids;
    const view = this.editor.view;
    const rect = this.scrollContainer.getBoundingClientRect();
    const blocks = allBlocks(view.state.doc);
    let ids: string[] = [];
    try {
      const top = view.posAtCoords({ left: rect.left + rect.width / 2, top: Math.max(rect.top + 4, 0) });
      const bottom = view.posAtCoords({ left: rect.left + rect.width / 2, top: Math.min(rect.bottom - 4, window.innerHeight - 1) });
      const from = top?.pos ?? 0;
      const to = bottom?.pos ?? view.state.doc.content.size;
      const cursor = view.state.selection.head;
      ids = blocks
        .filter((b) => b.pos + b.node.nodeSize >= from - 1 && b.pos <= to + 1)
        .sort((a, b) => Math.abs(a.pos - cursor) - Math.abs(b.pos - cursor))
        .map((b) => b.id);
    } catch {
      ids = blocks.slice(0, 20).map((b) => b.id);
    }
    this.visibleCache = { at: now, ids };
    return ids;
  }

  private onScroll(): void {
    this.visibleCache.at = 0;
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.scheduler.viewportChanged();
      this.scheduleViewStateSave();
    }, 200);
    const card = this.state.get().card;
    if (card) this.state.set({ card: { ...card, tick: card.tick + 1 } });
  }

  private async runLocal(ids: string[]): Promise<void> {
    const doc = this.editor.state.doc;
    const head = this.editor.state.selection.empty ? this.editor.state.selection.head : null;
    const inputs = [];
    for (const id of ids) {
      const b = findBlock(doc, id);
      if (!b) continue;
      const text = textOfBlock(b.node);
      const start = b.pos + 1;
      const cursorOffset = head !== null && head >= start && head <= start + text.length ? head - start : null;
      inputs.push({ blockId: id, text, hash: hashText(text), cursorOffset, codeRanges: this.codeRanges(b) });
    }
    if (!inputs.length) return;
    const settings = this.env.getSettings();
    const revision = getSuggestionsState(this.editor.state).revision;
    const results = await this.env.local.analyze(inputs, { sensitivity: settings.sensitivity, dictionary: this.env.getDictionary() });
    if (this.disposed) return;
    for (const r of results) {
      if (r.cursorSuppressed) this.cursorSuppressedBlocks.add(r.blockId);
      else this.cursorSuppressedBlocks.delete(r.blockId);
      this.applyFindings(r.blockId, r.hash, r.findings, 'local', revision);
    }
  }

  private async requestAI(input: AIRequestInput, signal: AbortSignal): Promise<Finding[]> {
    const settings = this.env.getSettings();
    const b = findBlock(this.editor.state.doc, input.blockId);
    const ranges = b ? this.codeRanges(b) : [];
    const end = input.windowStart + input.text.length;
    const protectedRanges = ranges
      .filter((r) => r.end > input.windowStart && r.start < end)
      .map((r) => [Math.max(0, r.start - input.windowStart), Math.min(input.text.length, r.end - input.windowStart)] as [number, number]);
    const res = await checkText(
      {
        text: input.text,
        context: input.context,
        dialect: settings.dialect,
        goal: this.doc.settings.goal,
        sensitivity: settings.sensitivity,
        categories: CATEGORIES.filter((c) => settings.categories[c]),
        protectedRanges,
      },
      signal,
    );
    debugLog('ai.response', { blockId: input.blockId, issues: res.issues.length, latencyMs: res.meta.latencyMs, revision: input.revision });
    return res.issues.map((i) => ({
      start: i.start,
      end: i.end,
      original: i.original,
      replacements: i.replacements,
      category: i.category,
      severity: i.severity,
      ruleId: `ai:${i.category}`,
      title: i.title,
      explanation: i.explanation,
      confidence: i.confidence,
    }));
  }

  // ── applying results ──────────────────────────────────────────────────────

  private filterFindings(findings: readonly Finding[], text: string, hash: string): Finding[] {
    const settings = this.env.getSettings();
    const threshold = CONFIDENCE_THRESHOLD[settings.sensitivity];
    const dict = new Set(this.env.getDictionary());
    return findings.filter((f) => {
      if (!settings.categories[f.category]) return false;
      if (f.confidence < threshold) return false;
      if (this.doc.ignoredRules.has(f.ruleId)) return false;
      if (f.category === 'spelling' && dict.has(normalizeDictionaryWord(f.original))) return false;
      if (this.suppressed.has(`${hash}|${f.original}|${f.replacements[0] ?? ''}`)) return false;
      const probe = { blockHash: hash, original: f.original, ruleId: f.ruleId, category: f.category, source: f.ruleId.startsWith('ai:') ? ('ai' as const) : ('local' as const) };
      return !isDismissed(this.doc.dismissed, probe, text, f.start);
    });
  }

  applyFindings(blockId: string, hash: string, findings: Finding[], source: Source, revision: number): void {
    if (this.disposed) return;
    this.raw.set(`${blockId}|${source}`, { hash, findings, revision });
    const run = () => {
      const doc = this.editor.state.doc;
      const b = findBlock(doc, blockId);
      if (!b) return;
      const text = textOfBlock(b.node);
      if (hashText(text) !== hash) {
        debugLog(`${source}.stale`, { blockId, requestRevision: revision, currentRevision: getSuggestionsState(this.editor.state).revision });
        return;
      }
      const anchored = anchorFindings(doc, blockId, hash, this.filterFindings(findings, text, hash), { source, revision });
      if (!anchored) return;
      this.dispatchMeta({ type: 'setBlock', blockId, source, suggestions: anchored });
      debugLog(`${source}.applied`, { blockId, count: anchored.length, revision });
    };
    if (this.editor.view.composing) this.pendingWhileComposing.set(`${blockId}|${source}`, run);
    else run();
  }

  private reapplyRaw(): void {
    for (const [key, r] of this.raw) {
      const [blockId, source] = key.split('|') as [string, Source];
      this.applyFindings(blockId, r.hash, r.findings, source, r.revision);
    }
  }

  private dispatchMeta(meta: SuggestionsMeta): void {
    if (this.disposed) return;
    const tr = this.editor.state.tr.setMeta(suggestionsKey, meta).setMeta('addToHistory', false);
    this.editor.view.dispatch(tr);
  }

  // ── publishing to React ───────────────────────────────────────────────────

  private schedulePublish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (this.disposed) return;
      const suggestions = displayedSuggestions(this.editor.state);
      this.state.set({ suggestions });
      this.scheduleAnnouncement(suggestions.length);
    }, PUBLISH_MS);
  }

  private scheduleAnnouncement(count: number): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      if (count === this.lastAnnouncedCount) return;
      this.lastAnnouncedCount = count;
      this.state.set({ announcement: count === 0 ? 'No suggestions' : `${count} suggestion${count === 1 ? '' : 's'}` });
    }, 1500);
  }

  private scheduleStats(): void {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      if (!this.disposed) this.publishStats();
    }, 400);
  }

  private publishStats(): void {
    const text = this.editor.state.doc.textBetween(0, this.editor.state.doc.content.size, '\n', ' ');
    const words = countWords(text);
    this.state.set({ words, readingMinutes: readingTimeMinutes(words) });
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private snapshot() {
    const doc = this.editor.state.doc;
    const text = doc.textBetween(0, doc.content.size, '\n\n', ' ');
    return { content: this.editor.getJSON(), text, wordCount: countWords(text) };
  }

  private async save(): Promise<'ok' | 'conflict'> {
    const snap = this.snapshot();
    const result = await this.env.store.saveContent(this.doc.id, snap, this.doc.version);
    if (!result.ok) {
      debugLog('save.conflict', { doc: this.doc.id, mine: this.doc.version, theirs: result.conflict.version });
      return 'conflict';
    }
    this.doc.version = result.version;
    this.env.onSaved?.({ id: this.doc.id, wordCount: snap.wordCount, updatedAt: result.updatedAt });
    this.env.tabSync.post({ type: 'saved', docId: this.doc.id, version: result.version });
    return 'ok';
  }

  /** Resolve a cross-tab conflict by overwriting with this tab's content. */
  async keepMine(): Promise<void> {
    const current = await this.env.store.get(this.doc.id);
    if (current) this.doc.version = current.version;
    this.autosaver.resume();
    await this.autosaver.flush();
  }

  /** Another tab saved this document. Returns true if the caller should reload it. */
  externalSave(version: number): 'reload' | 'conflict' | 'ignore' {
    if (version <= this.doc.version) return 'ignore';
    if (this.autosaver.hasUnsavedChanges) {
      this.autosaver.pause();
      this.state.set({ saveState: 'conflict' });
      return 'conflict';
    }
    return 'reload';
  }

  private scheduleViewStateSave(): void {
    if (this.metaTimer) clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      void this.persistViewState();
    }, 800);
  }

  private async persistViewState(): Promise<void> {
    if (this.disposed) return;
    const { anchor, head } = this.editor.state.selection;
    await this.env.store.updateMeta(this.doc.id, { selection: { anchor, head }, scrollTop: Math.round(this.scrollContainer.scrollTop), openedAt: Date.now() });
  }

  private restoreView(record: DocumentRecord): void {
    const doc = this.editor.state.doc;
    const size = doc.content.size;
    if (record.selection) {
      const clamp = (n: number) => Math.max(0, Math.min(size, n));
      try {
        const sel = TextSelection.between(doc.resolve(clamp(record.selection.anchor)), doc.resolve(clamp(record.selection.head)));
        this.editor.view.dispatch(this.editor.state.tr.setSelection(sel).setMeta('addToHistory', false));
      } catch {
        // ignore invalid saved selection
      }
    }
    requestAnimationFrame(() => {
      if (this.disposed) return;
      this.scrollContainer.scrollTop = record.scrollTop;
      this.editor.view.focus();
    });
  }

  // ── suggestion actions ────────────────────────────────────────────────────

  getSuggestion(id: string): Suggestion | undefined {
    return getSuggestionsState(this.editor.state).items.get(id);
  }

  accept(id: string, index = 0): void {
    const state = this.editor.state;
    const s = getSuggestionsState(state).items.get(id);
    if (!s) return;
    const replacement = s.replacements[index];
    if (replacement === undefined) return;
    const pos = verifySuggestion(state.doc, s);
    if (!pos) {
      // Unverifiable: never touch the document.
      debugLog('accept.unverifiable', { id });
      this.dispatchMeta({ type: 'remove', ids: [id] });
      this.closeCard();
      return;
    }
    const tr = state.tr;
    closeHistory(tr);
    tr.insertText(replacement, pos.from, pos.to);
    // A zero time means the next keystroke opens a new undo group: accept is exactly one undo step.
    tr.setTime(0);
    tr.setMeta(suggestionsKey, { type: 'remove', ids: [id] } satisfies SuggestionsMeta);
    tr.setMeta('inkwell:accept', id);
    this.recentAccepts.push({ blockId: s.blockId, original: s.original, replacement, at: Date.now() });
    if (this.recentAccepts.length > 50) this.recentAccepts.shift();
    this.closeCard();
    this.editor.view.dispatch(tr);
    debugLog('suggestion.accepted', { id, source: s.source, category: s.category });
    this.announce(replacement ? `Replaced with “${replacement}”` : 'Removed');
  }

  dismiss(id: string): void {
    const state = this.editor.state;
    const s = getSuggestionsState(state).items.get(id);
    if (!s) return;
    const b = findBlock(state.doc, s.blockId);
    const text = b ? textOfBlock(b.node) : null;
    const offset = b ? s.from - (b.pos + 1) : null;
    // The same span may also have been reported by the other tier (shadowed by dedupe): dismiss those too.
    const twins = [...getSuggestionsState(state).items.values()].filter((x) => x.blockId === s.blockId && x.from === s.from && x.to === s.to);
    for (const t of twins) for (const k of dismissKeys(t, text, offset)) this.doc.dismissed.add(k);
    void this.env.store.updateMeta(this.doc.id, { dismissed: [...this.doc.dismissed].slice(-2000) });
    this.dispatchMeta({ type: 'remove', ids: twins.map((t) => t.id) });
    this.closeCard();
    debugLog('suggestion.dismissed', { id });
    this.announce('Dismissed');
  }

  addToDictionary(id: string): void {
    const s = this.getSuggestion(id);
    if (!s) return;
    this.env.addToDictionary(s.original);
    this.closeCard();
    this.announce(`Added “${s.original}” to your dictionary`);
  }

  ignoreRule(id: string): void {
    const s = this.getSuggestion(id);
    if (!s) return;
    const rule = ruleKeyOf(s);
    this.doc.ignoredRules.add(rule);
    this.state.set({ ignoredRules: [...this.doc.ignoredRules] });
    void this.env.store.updateMeta(this.doc.id, { ignoredRules: [...this.doc.ignoredRules] });
    this.dispatchMeta({ type: 'filter', keep: (x) => ruleKeyOf(x) !== rule });
    this.closeCard();
    this.announce('Rule ignored in this document');
  }

  restoreRule(rule: string): void {
    this.doc.ignoredRules.delete(rule);
    this.state.set({ ignoredRules: [...this.doc.ignoredRules] });
    void this.env.store.updateMeta(this.doc.id, { ignoredRules: [...this.doc.ignoredRules] });
    this.reapplyRaw();
  }

  /** After undo/redo: don't re-flag an issue the author just un-accepted. */
  private onUndoRedo(): void {
    const doc = this.editor.state.doc;
    const now = Date.now();
    for (const r of this.recentAccepts) {
      if (now - r.at > 30 * 60_000) continue;
      const b = findBlock(doc, r.blockId);
      if (!b) continue;
      const text = textOfBlock(b.node);
      if (text.includes(r.original)) this.suppressed.add(`${hashText(text)}|${r.original}|${r.replacement}`);
    }
  }

  // ── cards ─────────────────────────────────────────────────────────────────

  openCard(id: string, mode: CardMode): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    const st = getSuggestionsState(this.editor.state);
    if (!st.visible.has(id)) return;
    const current = this.state.get().card;
    if (current?.id === id && current.mode === 'pinned' && mode === 'pinned') return;
    this.whyAbort?.abort();
    this.state.set({ card: { id, mode, tick: (current?.tick ?? 0) + 1, why: { status: 'idle', text: '' } }, selectionMenu: null });
    if (st.activeId !== id) this.dispatchMeta({ type: 'setActive', id });
  }

  closeCard(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.whyAbort?.abort();
    if (!this.state.get().card) return;
    this.state.set({ card: null });
    if (getSuggestionsState(this.editor.state).activeId) this.dispatchMeta({ type: 'setActive', id: null });
  }

  private onHover(id: string | null, _el: HTMLElement | null): void {
    const card = this.state.get().card;
    if (card && card.mode !== 'hover') return;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (id) {
      if (card?.id === id) return;
      this.hoverTimer = setTimeout(() => this.openCard(id, 'hover'), HOVER_SHOW_MS);
    } else if (card) {
      this.hoverTimer = setTimeout(() => this.closeCard(), HOVER_HIDE_MS);
    }
  }

  /** The card itself is hovered: keep it open. */
  cardPointer(inside: boolean): void {
    const card = this.state.get().card;
    if (!card || card.mode !== 'hover') return;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = inside ? null : setTimeout(() => this.closeCard(), HOVER_HIDE_MS);
  }

  /** Open the card for the issue at, or nearest to, the cursor. */
  openAtCursor(): boolean {
    const list = displayedSuggestions(this.editor.state);
    if (!list.length) {
      this.announce('No suggestions');
      return false;
    }
    const head = this.editor.state.selection.head;
    const inside = list.find((s) => head >= s.from && head <= s.to);
    const target = inside ?? list.reduce((best, s) => (Math.min(Math.abs(s.from - head), Math.abs(s.to - head)) < Math.min(Math.abs(best.from - head), Math.abs(best.to - head)) ? s : best));
    // Never move the caret just to show a card: typing after Escape must continue where it was.
    this.revealSuggestion(target.id, false);
    return true;
  }

  jump(direction: 1 | -1): boolean {
    const list = displayedSuggestions(this.editor.state);
    if (!list.length) {
      this.announce('No suggestions');
      return false;
    }
    const head = this.editor.state.selection.head;
    const card = this.state.get().card;
    let target: Suggestion | undefined;
    if (direction === 1) target = list.find((s) => s.from > head || (s.from === head && card?.id !== s.id)) ?? list[0];
    else target = [...list].reverse().find((s) => s.to < head || (s.from < head && card?.id !== s.id && s.to !== head)) ?? list[list.length - 1];
    if (!target) return false;
    this.revealSuggestion(target.id, true);
    return true;
  }

  /** Scroll to a suggestion, optionally put the cursor at its start, and open its card armed for the keyboard. */
  revealSuggestion(id: string, moveCursor: boolean, mode: CardMode = 'keyboard'): void {
    const s = this.getSuggestion(id);
    if (!s) return;
    if (moveCursor) {
      const tr = this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, s.from)).setMeta('addToHistory', false);
      this.editor.view.dispatch(tr);
    }
    const dom = this.editor.view.domAtPos(s.from);
    const el = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    this.openCard(id, mode);
    const n = displayedSuggestions(this.editor.state).findIndex((x) => x.id === id);
    this.announce(`${s.title}: ${s.original}${s.replacements[0] !== undefined ? ` → ${s.replacements[0] || 'remove'}` : ''}. Issue ${n + 1} of ${this.state.get().suggestions.length || n + 1}.`);
  }

  /** Why? For AI suggestions, ask the model for a fuller explanation on demand. */
  async explainSuggestion(id: string): Promise<void> {
    const s = this.getSuggestion(id);
    const card = this.state.get().card;
    if (!s || !card || card.id !== id) return;
    if (s.source !== 'ai' || !(this.aiMode() === 'ai')) {
      this.state.set({ card: { ...card, why: { status: 'done', text: s.explanation ?? '' } } });
      return;
    }
    this.whyAbort?.abort();
    const controller = new AbortController();
    this.whyAbort = controller;
    this.state.set({ card: { ...card, why: { status: 'loading', text: '' } } });
    const b = findBlock(this.editor.state.doc, s.blockId);
    try {
      const settings = this.env.getSettings();
      await streamWrite(
        {
          action: 'why',
          text: b ? textOfBlock(b.node).slice(0, 2000) : s.original,
          dialect: settings.dialect,
          goal: this.doc.settings.goal,
          suggestion: { original: s.original, replacement: s.replacements[0] ?? '', title: s.title, category: s.category },
        },
        controller.signal,
        {
          onText: (full) => {
            const c = this.state.get().card;
            if (c?.id === id) this.state.set({ card: { ...c, why: { status: 'loading', text: full } } });
          },
        },
      ).then((full) => {
        const c = this.state.get().card;
        if (c?.id === id) this.state.set({ card: { ...c, why: { status: 'done', text: full.trim() } } });
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const c = this.state.get().card;
      if (c?.id === id) this.state.set({ card: { ...c, why: { status: 'error', text: describeWriteError(err) } } });
    }
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  private onKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (view.composing || event.isComposing) return false;
    const mod = event.metaKey || event.ctrlKey;
    const card = this.state.get().card;
    const preview = getPreview(view.state);

    if (card) {
      const s = this.getSuggestion(card.id);
      if (event.key === 'Escape') {
        this.closeCard();
        return true;
      }
      if (card.mode === 'keyboard' && s && !mod && !event.altKey) {
        if (event.key === 'Enter' && !event.shiftKey && s.replacements.length > 0) {
          this.accept(s.id, 0);
          return true;
        }
        if (/^[1-3]$/.test(event.key) && s.replacements.length > 0) {
          const idx = Number(event.key) - 1;
          if (idx < s.replacements.length) {
            this.accept(s.id, idx);
            return true;
          }
        }
        if (event.key === 'Tab' && !event.shiftKey) {
          this.state.set({ card: { ...card, tick: card.tick + 1, mode: 'keyboard' } });
          document.dispatchEvent(new CustomEvent('inkwell:focus-card'));
          return true;
        }
      }
      // Any other key closes the card and types normally.
      if (!['Shift', 'Control', 'Alt', 'Meta', 'F8'].includes(event.key) && !(event.altKey && event.key === 'Enter')) this.closeCard();
    }

    if (preview) {
      if (event.key === 'Escape') {
        this.discardPreview();
        return true;
      }
      if (preview.kind === 'continue' && preview.status === 'done' && (event.key === 'Tab' || event.key === 'Enter') && !mod && !event.shiftKey) {
        this.acceptPreview();
        return true;
      }
      if (preview.kind === 'rewrite' && preview.status === 'done' && event.key === 'Enter' && mod) {
        this.acceptPreview();
        return true;
      }
    }

    if (event.key === 'Escape' && this.state.get().selectionMenu) {
      this.state.set({ selectionMenu: null });
      return true;
    }
    if (event.key === 'F8') {
      this.jump(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.altKey && !mod && event.key === 'Enter') {
      const sel = view.state.selection;
      if (!sel.empty) this.state.set({ selectionMenu: { from: sel.from, to: sel.to, keyboard: true } });
      else this.openAtCursor();
      return true;
    }
    if (mod && event.shiftKey && event.key === 'Enter') {
      void this.continueWriting();
      return true;
    }
    return false;
  }

  // ── selection menu ────────────────────────────────────────────────────────

  private scheduleSelectionMenu(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    const sel = this.editor.state.selection;
    const menu = this.state.get().selectionMenu;
    if (sel.empty) {
      if (menu) this.state.set({ selectionMenu: null });
      return;
    }
    if (menu && (menu.from !== sel.from || menu.to !== sel.to)) this.state.set({ selectionMenu: null });
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      if (this.disposed || this.pointerDown) return;
      const s = this.editor.state.selection;
      if (s.empty || getPreview(this.editor.state) || !this.editor.view.hasFocus()) return;
      if (!textBetween(this.editor.state.doc, s.from, s.to).trim()) return;
      this.state.set({ selectionMenu: { from: s.from, to: s.to, keyboard: false } });
    }, SELECTION_SETTLE_MS);
  }

  closeSelectionMenu(): void {
    this.state.set({ selectionMenu: null });
  }

  // ── writing actions ───────────────────────────────────────────────────────

  aiWritingAvailable(): boolean {
    return this.aiMode() === 'ai';
  }

  /** Rewrite the given range (default: current selection) with a streamed inline preview. */
  async rewrite(action: WriteAction, opts: { tone?: Tone; instruction?: string; label: string; range?: { from: number; to: number } }): Promise<void> {
    if (!this.aiWritingAvailable()) {
      this.env.notify(this.aiUnavailableMessage());
      return;
    }
    const state = this.editor.state;
    const from = opts.range?.from ?? state.selection.from;
    const to = opts.range?.to ?? state.selection.to;
    if (to <= from) return;
    this.cancelPreview();
    this.state.set({ selectionMenu: null });
    this.closeCard();
    const doc = state.doc;
    const text = doc.textBetween(from, to, '\n\n', leafText);
    const before = doc.textBetween(Math.max(0, from - 600), from, '\n\n', leafText);
    const after = doc.textBetween(to, Math.min(doc.content.size, to + 600), '\n\n', leafText);
    const id = makeId('p');
    this.lastPreviewRequest = { action, tone: opts.tone, instruction: opts.instruction, label: opts.label };
    this.dispatchPreview({ type: 'start', preview: { id, kind: 'rewrite', from, to, label: opts.label, text: '', status: 'streaming' } });
    // Collapse the selection to the end so typing elsewhere is natural and the preview stays visible.
    this.editor.view.dispatch(this.editor.state.tr.setSelection(TextSelection.create(this.editor.state.doc, to)).setMeta('addToHistory', false));
    const settings = this.env.getSettings();
    await this.stream(id, { action, text, before, after, tone: opts.tone, instruction: opts.instruction, dialect: settings.dialect, goal: this.doc.settings.goal });
  }

  async continueWriting(): Promise<void> {
    if (!this.aiWritingAvailable()) {
      this.env.notify(this.aiUnavailableMessage());
      return;
    }
    const state = this.editor.state;
    if (!state.selection.empty) return;
    const pos = state.selection.head;
    const text = state.doc.textBetween(Math.max(0, pos - 1500), pos, '\n\n', leafText);
    if (!text.trim()) {
      this.env.notify('Write a sentence or two first, then Inkwell can continue it.');
      return;
    }
    this.cancelPreview();
    const id = makeId('p');
    this.lastPreviewRequest = { action: 'continue', label: 'Continue writing' };
    this.dispatchPreview({ type: 'start', preview: { id, kind: 'continue', from: pos, to: pos, label: 'Continue writing', text: '', status: 'streaming' } });
    const settings = this.env.getSettings();
    await this.stream(id, { action: 'continue', text, dialect: settings.dialect, goal: this.doc.settings.goal });
  }

  private async stream(id: string, req: Parameters<typeof streamWrite>[0]): Promise<void> {
    const controller = new AbortController();
    this.previewAbort = controller;
    let frame = 0;
    let latest = '';
    const flush = () => {
      frame = 0;
      const p = getPreview(this.editor.state);
      if (p?.id === id) this.dispatchPreview({ type: 'update', id, text: cleanStreamed(latest, p.kind), status: 'streaming' });
    };
    try {
      const full = await streamWrite(req, controller.signal, {
        onText: (text) => {
          latest = text;
          if (!frame) frame = requestAnimationFrame(flush);
        },
      });
      if (frame) cancelAnimationFrame(frame);
      const p = getPreview(this.editor.state);
      if (p?.id === id) {
        this.dispatchPreview({ type: 'update', id, text: cleanStreamed(full, p.kind), status: 'done' });
        this.announce(p.kind === 'continue' ? 'Suggestion ready. Press Tab to accept or Escape to discard.' : 'Preview ready. Accept, discard, or retry.');
      }
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      if (controller.signal.aborted) return;
      const p = getPreview(this.editor.state);
      if (p?.id === id) this.dispatchPreview({ type: 'update', id, text: p.text, status: 'error', error: describeWriteError(err) });
      debugLog('write.error', { kind: err instanceof AIRequestError ? err.kind : 'unknown' });
    } finally {
      if (this.previewAbort === controller) this.previewAbort = null;
    }
  }

  acceptPreview(): void {
    const p = getPreview(this.editor.state);
    if (!p || p.status !== 'done') return;
    const text = p.kind === 'continue' ? p.text.replace(/\s+$/, '') : p.text.trim();
    if (!text) {
      this.discardPreview();
      return;
    }
    const clear: PreviewMeta = { type: 'clear', id: p.id };
    if (p.kind === 'continue') {
      const before = this.editor.state.doc.textBetween(Math.max(0, p.from - 1), p.from, '\n', leafText);
      let insert = text.replace(/^\s+/, '');
      // Join naturally: add a space after a word or punctuation, never after existing whitespace.
      if (before && !/\s/.test(before) && /^[\p{L}\p{N}"“(]/u.test(insert)) insert = ` ${insert}`;
      const tr = this.editor.state.tr;
      closeHistory(tr);
      tr.insertText(insert, p.from, p.from).setTime(0).setMeta(previewKey, clear);
      this.editor.view.dispatch(tr);
    } else if (/\n\s*\n/.test(text)) {
      const paragraphs = text.split(/\n\s*\n/).map((t) => ({ type: 'paragraph', content: t.trim() ? [{ type: 'text', text: t.trim() }] : [] }));
      this.editor
        .chain()
        .command(({ tr }) => {
          closeHistory(tr);
          tr.setTime(0).setMeta(previewKey, clear);
          return true;
        })
        .insertContentAt({ from: p.from, to: p.to }, paragraphs)
        .run();
    } else {
      const tr = this.editor.state.tr;
      closeHistory(tr);
      tr.insertText(text, p.from, p.to).setTime(0).setMeta(previewKey, clear);
      this.editor.view.dispatch(tr);
    }
    this.editor.view.focus();
    this.announce('Change applied');
    debugLog('preview.accepted', { kind: p.kind });
  }

  discardPreview(): void {
    this.cancelPreview();
    this.editor.view.focus();
  }

  retryPreview(): void {
    const p = getPreview(this.editor.state);
    const req = this.lastPreviewRequest;
    if (!p || !req) return;
    if (p.kind === 'continue') void this.continueWriting();
    else void this.rewrite(req.action, { tone: req.tone, instruction: req.instruction, label: req.label, range: { from: p.from, to: p.to } });
  }

  private cancelPreview(): void {
    this.previewAbort?.abort();
    this.previewAbort = null;
    if (getPreview(this.editor.state)) this.dispatchPreview({ type: 'clear' });
  }

  private dispatchPreview(meta: PreviewMeta): void {
    if (this.disposed) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(previewKey, meta).setMeta('addToHistory', false));
  }

  /** Text used for "Summarize document". */
  documentText(): string {
    const doc = this.editor.state.doc;
    return doc.textBetween(0, doc.content.size, '\n\n', leafText);
  }

  selectionText(): { text: string; before: string; after: string } | null {
    const { from, to, empty } = this.editor.state.selection;
    const doc = this.editor.state.doc;
    if (empty) return null;
    return {
      text: doc.textBetween(from, to, '\n\n', leafText),
      before: doc.textBetween(Math.max(0, from - 600), from, '\n\n', leafText),
      after: doc.textBetween(to, Math.min(doc.content.size, to + 600), '\n\n', leafText),
    };
  }

  /** Insert text at the cursor as one undo step (summary "Insert"). Bullet lines become a list. */
  insertAtCursor(text: string): void {
    const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const bullets = lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l));
    const content: JSONContent[] = bullets
      ? [{ type: 'bulletList', content: lines.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: l.replace(/^[-*•]\s+/, '') }] }] })) }]
      : text.trim().split(/\n\s*\n/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.trim() }] }));
    this.editor
      .chain()
      .focus()
      .command(({ tr }) => {
        closeHistory(tr);
        tr.setTime(0);
        return true;
      })
      .insertContent(content)
      .run();
  }

  aiUnavailableMessage(): string {
    switch (this.aiMode()) {
      case 'local-only':
        return 'Local-only mode is on. Turn it off in Settings to use AI writing actions.';
      case 'doc-off':
        return 'AI is turned off for this document. You can turn it on in Settings.';
      case 'offline':
        return 'You’re offline. AI writing actions need a connection.';
      case 'paused':
        return 'AI is taking a short break after a few failed requests. It will retry shortly.';
      case 'not-configured':
        return 'AI isn’t configured on this server. Local checks are still running.';
      default:
        return '';
    }
  }

  // ── misc ──────────────────────────────────────────────────────────────────

  announce(message: string): void {
    this.state.set({ announcement: '' });
    queueMicrotask(() => this.state.set({ announcement: message }));
  }

  private typewriterScroll(): void {
    const view = this.editor.view;
    try {
      const coords = view.coordsAtPos(view.state.selection.head);
      const rect = this.scrollContainer.getBoundingClientRect();
      const target = rect.top + rect.height * 0.45;
      const delta = coords.top - target;
      if (Math.abs(delta) > 24) this.scrollContainer.scrollBy({ top: delta, behavior: 'auto' });
    } catch {
      // coordsAtPos can throw mid-layout
    }
  }
}

/** Strip wrapping quotes/fences a model may add around a rewrite. */
export function cleanStreamed(text: string, kind: 'rewrite' | 'continue'): string {
  let out = text.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '');
  if (kind === 'rewrite') {
    out = out.trim();
    if (/^["“].*["”]$/s.test(out) && !/["“”]/.test(out.slice(1, -1))) out = out.slice(1, -1);
  }
  return out;
}
