/**
 * Inline previews for AI writing actions, rendered purely as decorations:
 *  - rewrite: the target range is struck through and the proposal streams in
 *    as a ghost insertion right after it. Nothing replaces the author's text
 *    until they accept.
 *  - continue: ghost text streams in at the cursor.
 * Editing the target range (or, for continue, any edit or cursor move) cancels.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mapSuggestionRange } from './suggestions-plugin';

export type PreviewKind = 'rewrite' | 'continue';

export interface Preview {
  id: string;
  kind: PreviewKind;
  from: number;
  to: number;
  label: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

export interface PreviewState {
  preview: Preview | null;
  /** Set on the transaction that cancelled a preview because the text changed. */
  cancelledId: string | null;
}

export type PreviewMeta =
  | { type: 'start'; preview: Preview }
  | { type: 'update'; id: string; text: string; status: Preview['status']; error?: string }
  | { type: 'clear'; id?: string };

export const previewKey = new PluginKey<PreviewState>('inkwell-preview');

function apply(tr: Transaction, prev: PreviewState, _old: EditorState, state: EditorState): PreviewState {
  const meta = tr.getMeta(previewKey) as PreviewMeta | undefined;
  let preview = prev.preview;
  let cancelledId: string | null = null;

  if (meta?.type === 'start') return { preview: meta.preview, cancelledId: null };
  if (meta?.type === 'clear') {
    if (!meta.id || meta.id === preview?.id) preview = null;
    return { preview, cancelledId: null };
  }

  if (preview && tr.docChanged) {
    if (preview.kind === 'continue') {
      cancelledId = preview.id;
      preview = null;
    } else {
      const mapped = mapSuggestionRange(preview, tr);
      if (!mapped) {
        cancelledId = preview.id;
        preview = null;
      } else if (mapped.from !== preview.from || mapped.to !== preview.to) preview = { ...preview, ...mapped };
    }
  }
  if (preview?.kind === 'continue' && tr.selectionSet && !tr.docChanged && state.selection.head !== preview.from) {
    cancelledId = preview.id;
    preview = null;
  }
  if (meta?.type === 'update' && preview && meta.id === preview.id) {
    preview = { ...preview, text: meta.text, status: meta.status, error: meta.error };
  }
  if (preview === prev.preview && cancelledId === null && prev.cancelledId === null) return prev;
  return { preview, cancelledId };
}

function widget(p: Preview) {
  return Decoration.widget(
    p.to,
    () => {
      const span = document.createElement('span');
      span.className = p.kind === 'rewrite' ? 'ink-diff-ins' : 'ink-ghost';
      span.setAttribute('contenteditable', 'false');
      span.setAttribute('aria-hidden', 'true');
      span.dataset.previewId = p.id;
      span.textContent = p.kind === 'rewrite' && p.text && !/^\s/.test(p.text) ? ` ${p.text}` : p.text;
      if (p.status === 'streaming') {
        const caret = document.createElement('span');
        caret.className = 'ink-stream-caret';
        span.appendChild(caret);
      }
      return span;
    },
    { side: 1, key: `${p.id}:${p.text.length}:${p.status}`, ignoreSelection: true },
  );
}

export function createPreviewPlugin(): Plugin<PreviewState> {
  return new Plugin<PreviewState>({
    key: previewKey,
    state: { init: () => ({ preview: null, cancelledId: null }), apply },
    props: {
      decorations(state) {
        const p = previewKey.getState(state)?.preview;
        if (!p) return null;
        const decos: Decoration[] = [];
        if (p.kind === 'rewrite' && p.to > p.from) {
          decos.push(Decoration.inline(p.from, p.to, { class: 'ink-diff-del' }));
        }
        decos.push(widget(p));
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

export function getPreview(state: EditorState): Preview | null {
  return previewKey.getState(state)?.preview ?? null;
}
