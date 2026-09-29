import type { AppController } from './app-controller';
import { displayedSuggestions } from '@/editor/suggestions-plugin';
import { textBetween } from '@/suggestions/anchor';

/**
 * Read-only diagnostics on window.__inkwell, used by end-to-end tests and
 * handy in devtools. Exposes no document text beyond what is already on screen.
 */
export function installDebugHooks(app: AppController): () => void {
  const hooks = {
    /** Every displayed suggestion must match the text at its range, and its DOM underline must too. */
    verifySuggestions() {
      const session = app.session;
      if (!session) return { ok: true, count: 0, problems: [] as string[] };
      const state = session.editor.state;
      const problems: string[] = [];
      const list = displayedSuggestions(state);
      for (const s of list) {
        const actual = textBetween(state.doc, s.from, s.to);
        if (actual !== s.original) problems.push(`range mismatch: "${actual}" vs "${s.original}"`);
      }
      for (let i = 1; i < list.length; i++) if (list[i]!.from < list[i - 1]!.to) problems.push('overlapping suggestions');
      const dom = [...session.editor.view.dom.querySelectorAll<HTMLElement>('[data-sid]')];
      const byId = new Map(list.map((s) => [s.id, s]));
      const domText = new Map<string, string>();
      for (const el of dom) domText.set(el.dataset.sid!, (domText.get(el.dataset.sid!) ?? '') + el.textContent);
      for (const [id, text] of domText) {
        const s = byId.get(id);
        if (!s) problems.push(`orphan underline "${text}"`);
        else if (text !== s.original) problems.push(`underline text "${text}" vs "${s.original}"`);
      }
      return { ok: problems.length === 0, count: list.length, problems };
    },
    selection() {
      const sel = app.session?.editor.state.selection;
      return sel ? { from: sel.from, to: sel.to, size: app.session!.editor.state.doc.content.size } : null;
    },
    /** Document-order index of a block id (for checking analysis priority). */
    blockIndex(id: string) {
      const session = app.session;
      if (!session) return -1;
      let i = -1;
      let found = -1;
      session.editor.state.doc.descendants((node) => {
        if (found !== -1) return false;
        if (node.isTextblock) {
          i++;
          if (node.attrs.bid === id) found = i;
          return false;
        }
        return true;
      });
      return found;
    },
    blockCount() {
      let n = 0;
      app.session?.editor.state.doc.descendants((node) => {
        if (node.isTextblock) {
          n++;
          return false;
        }
        return true;
      });
      return n;
    },
    suggestions() {
      return app.session ? displayedSuggestions(app.session.editor.state).map((s) => ({ original: s.original, replacements: s.replacements, source: s.source, category: s.category })) : [];
    },
  };
  (window as unknown as { __inkwell: typeof hooks }).__inkwell = hooks;
  return () => {
    delete (window as unknown as { __inkwell?: typeof hooks }).__inkwell;
  };
}
