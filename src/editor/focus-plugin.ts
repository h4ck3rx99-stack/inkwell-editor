/** Focus mode: marks the top-level block containing the cursor so CSS can dim the rest. */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const focusKey = new PluginKey<{ enabled: boolean }>('inkwell-focus');

export function createFocusPlugin(): Plugin<{ enabled: boolean }> {
  return new Plugin<{ enabled: boolean }>({
    key: focusKey,
    state: {
      init: () => ({ enabled: false }),
      apply(tr, prev) {
        const meta = tr.getMeta(focusKey) as { enabled: boolean } | undefined;
        return meta ? { enabled: meta.enabled } : prev;
      },
    },
    props: {
      decorations(state) {
        if (!focusKey.getState(state)?.enabled) return null;
        const $head = state.selection.$head;
        if ($head.depth < 1) return null;
        const start = $head.before(1);
        const node = state.doc.nodeAt(start);
        if (!node) return null;
        return DecorationSet.create(state.doc, [Decoration.node(start, start + node.nodeSize, { class: 'is-current' })]);
      },
    },
  });
}
