/**
 * Suggestions live in plugin state and render as inline Decorations only:
 * they never enter the document, the undo history, autosave or the clipboard.
 *
 * On every transaction each suggestion's range is mapped through tr.mapping;
 * an edit that touches or overlaps a range makes that suggestion stale and it
 * is removed immediately. Decorations are updated incrementally (only for
 * suggestions whose display state changed).
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isWordChar } from '@/lib/text';
import type { Source, Suggestion } from '@/suggestions/model';
import { selectVisible, sameFinding } from '@/suggestions/merge';
import { leafText } from '@/suggestions/anchor';

export interface SuggestionsState {
  /** All open candidate suggestions, including ones shadowed by a higher-priority overlap. */
  items: ReadonlyMap<string, Suggestion>;
  /** Ids chosen by overlap priority. Never overlapping. */
  visible: ReadonlySet<string>;
  /** Visible but not yet shown: created while the cursor was inside them. */
  deferred: ReadonlySet<string>;
  /** Shown with the fade-in class; cleared shortly after. */
  fresh: ReadonlySet<string>;
  activeId: string | null;
  deco: DecorationSet;
  /** Monotonic document revision (increments on every doc change). */
  revision: number;
  /** Increments whenever the displayed set changes; cheap change detection for subscribers. */
  version: number;
}

export type SuggestionsMeta =
  | { type: 'setBlock'; blockId: string; source: Source; suggestions: Suggestion[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'filter'; keep: (s: Suggestion) => boolean }
  | { type: 'setActive'; id: string | null }
  | { type: 'settleFresh' };

export const suggestionsKey = new PluginKey<SuggestionsState>('inkwell-suggestions');

export interface SuggestionsCallbacks {
  onHover(id: string | null, el: HTMLElement | null): void;
  onClick(id: string, el: HTMLElement): void;
  onKeyDown(view: EditorView, event: KeyboardEvent): boolean;
}

/**
 * Map a suggestion through a transaction. Returns null when any step touched
 * or overlapped its range. Pure insertions exactly at a boundary are allowed
 * when the inserted character next to the span is not a word character (so
 * typing a space or comma after a misspelling doesn't discard its underline).
 */
export function mapSuggestionRange(s: Pick<Suggestion, 'from' | 'to'>, tr: Transaction): { from: number; to: number } | null {
  let from = s.from;
  let to = s.to;
  for (let i = 0; i < tr.steps.length; i++) {
    const map = tr.mapping.maps[i]!;
    let touched = false;
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (touched || oldEnd < from || oldStart > to) return;
      if (oldStart === oldEnd && (oldStart === from || oldStart === to)) {
        const after: PMNode = tr.docs[i + 1] ?? tr.doc;
        const inserted = after.textBetween(newStart, newEnd, '\n', leafText);
        const adjacent = oldStart === to ? inserted[0] : inserted[inserted.length - 1];
        if (inserted.length > 0 && !isWordChar(adjacent)) return;
      }
      touched = true;
    });
    if (touched) return null;
    from = map.map(from, 1);
    to = map.map(to, -1);
    if (from >= to) return null;
  }
  return { from, to };
}

function cursorIn(state: EditorState, s: Pick<Suggestion, 'from' | 'to'>): boolean {
  const sel = state.selection;
  return sel.empty && sel.head >= s.from && sel.head <= s.to;
}

function decorationFor(s: Suggestion, fresh: boolean, active: boolean): Decoration {
  const cls = ['ink-sug', `ink-sug--${s.severity}`];
  if (fresh) cls.push('ink-sug--fresh');
  if (active) cls.push('ink-sug--active');
  return Decoration.inline(
    s.from,
    s.to,
    {
      class: cls.join(' '),
      'data-sid': s.id,
      'data-severity': s.severity,
      'data-source': s.source,
      'data-category': s.category,
    },
    { sid: s.id, inclusiveStart: false, inclusiveEnd: false },
  );
}

function computeVisible(items: ReadonlyMap<string, Suggestion>, blocks: ReadonlySet<string> | 'all', prev: ReadonlySet<string>): Set<string> {
  const next = new Set(prev);
  const byBlock = new Map<string, Suggestion[]>();
  for (const s of items.values()) {
    if (blocks !== 'all' && !blocks.has(s.blockId)) continue;
    let list = byBlock.get(s.blockId);
    if (!list) byBlock.set(s.blockId, (list = []));
    list.push(s);
  }
  for (const id of prev) {
    const s = items.get(id);
    if (!s || blocks === 'all' || blocks.has(s.blockId)) next.delete(id);
  }
  for (const list of byBlock.values()) for (const s of selectVisible(list)) next.add(s.id);
  return next;
}

function init(): SuggestionsState {
  return {
    items: new Map(), visible: new Set(), deferred: new Set(), fresh: new Set(),
    activeId: null, deco: DecorationSet.empty, revision: 0, version: 0,
  };
}

function apply(tr: Transaction, prev: SuggestionsState, _old: EditorState, state: EditorState): SuggestionsState {
  const meta = tr.getMeta(suggestionsKey) as SuggestionsMeta | undefined;
  if (!tr.docChanged && !meta && !(tr.selectionSet && prev.deferred.size)) return prev;

  let items = prev.items as Map<string, Suggestion>;
  let revision = prev.revision;
  let activeId = prev.activeId;
  let fresh = new Set(prev.fresh);
  const touchedBlocks = new Set<string>();
  let itemsChanged = false;

  if (tr.docChanged) {
    revision++;
    const next = new Map<string, Suggestion>();
    for (const s of items.values()) {
      const mapped = mapSuggestionRange(s, tr);
      if (!mapped) {
        touchedBlocks.add(s.blockId);
        itemsChanged = true;
        continue;
      }
      next.set(s.id, mapped.from === s.from && mapped.to === s.to ? s : { ...s, from: mapped.from, to: mapped.to });
    }
    items = next;
  }

  const newlyAdded = new Set<string>();
  if (meta) {
    switch (meta.type) {
      case 'setBlock': {
        const next = new Map(items);
        const existing: Suggestion[] = [];
        for (const s of items.values()) {
          if (s.blockId === meta.blockId && s.source === meta.source) {
            existing.push(s);
            next.delete(s.id);
          }
        }
        for (const incoming of meta.suggestions) {
          const keep = existing.find((e) => sameFinding(e, incoming));
          if (keep) next.set(keep.id, keep);
          else {
            next.set(incoming.id, incoming);
            newlyAdded.add(incoming.id);
          }
        }
        items = next;
        touchedBlocks.add(meta.blockId);
        itemsChanged = true;
        break;
      }
      case 'remove': {
        const next = new Map(items);
        for (const id of meta.ids) {
          const s = next.get(id);
          if (s) {
            touchedBlocks.add(s.blockId);
            next.delete(id);
          }
        }
        items = next;
        itemsChanged = true;
        break;
      }
      case 'filter': {
        const next = new Map<string, Suggestion>();
        for (const s of items.values()) {
          if (meta.keep(s)) next.set(s.id, s);
          else touchedBlocks.add(s.blockId);
        }
        items = next;
        itemsChanged = true;
        break;
      }
      case 'setActive':
        activeId = meta.id;
        break;
      case 'settleFresh':
        fresh = new Set();
        break;
    }
  }

  const visible = itemsChanged ? computeVisible(items, touchedBlocks, prev.visible) : new Set(prev.visible);
  for (const id of visible) if (!items.has(id)) visible.delete(id);

  // Deferral: a suggestion created under the caret waits until the caret leaves it.
  const deferred = new Set<string>();
  for (const id of visible) {
    const s = items.get(id)!;
    if (prev.deferred.has(id) || newlyAdded.has(id)) {
      if (cursorIn(state, s)) deferred.add(id);
    }
  }
  if (activeId && !visible.has(activeId)) activeId = null;

  // Incremental decoration update.
  let deco = tr.docChanged ? prev.deco.map(tr.mapping, tr.doc) : prev.deco;
  const shown = (id: string) => visible.has(id) && !deferred.has(id);
  const wasShown = (id: string) => prev.visible.has(id) && !prev.deferred.has(id) && (prev.items.has(id));
  const toRemove = new Set<string>();
  const toAdd: string[] = [];
  const candidates = new Set<string>([...prev.visible, ...visible]);
  for (const id of candidates) {
    const before = wasShown(id) && (!tr.docChanged || items.has(id));
    const after = shown(id);
    const activeChanged = (prev.activeId === id) !== (activeId === id);
    const freshChanged = prev.fresh.has(id) && !fresh.has(id);
    const moved = before && after && prev.items.get(id) !== items.get(id) && !tr.docChanged;
    if (before && (!after || activeChanged || freshChanged || moved)) toRemove.add(id);
    if (after && (!before || activeChanged || freshChanged || moved)) toAdd.push(id);
    if (after && !before) fresh.add(id);
  }
  // Stale ones (mapped away) must go too.
  for (const id of prev.visible) if (!items.has(id)) toRemove.add(id);
  for (const id of [...fresh]) if (!shown(id)) fresh.delete(id);

  if (toRemove.size) deco = deco.remove(deco.find(undefined, undefined, (spec) => toRemove.has(spec.sid as string)));
  if (toAdd.length) {
    deco = deco.add(
      tr.doc,
      toAdd.map((id) => decorationFor(items.get(id)!, fresh.has(id), id === activeId)),
    );
  }

  const displayChanged = toRemove.size > 0 || toAdd.length > 0 || itemsChanged;
  return {
    items, visible, deferred, fresh, activeId, deco, revision,
    version: displayChanged ? prev.version + 1 : prev.version,
  };
}

export function createSuggestionsPlugin(callbacks: SuggestionsCallbacks): Plugin<SuggestionsState> {
  let hoverEl: HTMLElement | null = null;
  const sidOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest('[data-sid]') as HTMLElement | null) : null);

  return new Plugin<SuggestionsState>({
    key: suggestionsKey,
    state: { init, apply },
    props: {
      decorations: (state) => suggestionsKey.getState(state)?.deco,
      handleKeyDown: (view, event) => callbacks.onKeyDown(view, event),
      handleClick(_view, _pos, event) {
        const el = sidOf(event.target);
        if (el?.dataset.sid) callbacks.onClick(el.dataset.sid, el);
        return false;
      },
      handleDOMEvents: {
        mouseover(_view, event) {
          const el = sidOf(event.target);
          if (el !== hoverEl) {
            hoverEl = el;
            callbacks.onHover(el?.dataset.sid ?? null, el);
          }
          return false;
        },
        mouseleave() {
          if (hoverEl) {
            hoverEl = null;
            callbacks.onHover(null, null);
          }
          return false;
        },
      },
    },
  });
}

export function getSuggestionsState(state: EditorState): SuggestionsState {
  return suggestionsKey.getState(state)!;
}

/** Displayed (visible, not deferred) suggestions in document order. */
export function displayedSuggestions(state: EditorState): Suggestion[] {
  const s = getSuggestionsState(state);
  const out: Suggestion[] = [];
  for (const id of s.visible) if (!s.deferred.has(id)) out.push(s.items.get(id)!);
  return out.sort((a, b) => a.from - b.from);
}
