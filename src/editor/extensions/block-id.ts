/**
 * Gives every textblock (paragraph, heading, list-item paragraph) a stable,
 * lightweight id. Analysis results, caches and in-flight requests are keyed
 * per block. Ids are never rendered to the DOM, so copy/paste always yields
 * fresh ids, and duplicates (e.g. after a split) are repaired immediately.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { makeId } from '@/lib/hash';
import { BLOCK_ID_ATTR } from '@/suggestions/anchor';

export const blockIdKey = new PluginKey('inkwell-block-id');
const ID_TYPES = ['paragraph', 'heading'];

/** Could this transaction have introduced or duplicated a block? Plain typing cannot. */
function mayAffectBlocks(tr: Transaction): boolean {
  for (const step of tr.steps) {
    if (!(step instanceof ReplaceStep)) return true;
    const { content } = step.slice;
    for (let i = 0; i < content.childCount; i++) if (!content.child(i).isInline) return true;
  }
  return false;
}

export function assignBlockIds(state: EditorState): Transaction | null {
  const seen = new Set<string>();
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (ID_TYPES.includes(node.type.name)) {
      const id = node.attrs[BLOCK_ID_ATTR] as string | null;
      if (!id || seen.has(id)) {
        tr ??= state.tr;
        const fresh = makeId('b');
        tr.setNodeAttribute(pos, BLOCK_ID_ATTR, fresh);
        seen.add(fresh);
      } else seen.add(id);
    }
    return false;
  });
  if (tr) (tr as Transaction).setMeta('addToHistory', false).setMeta(blockIdKey, true);
  return tr;
}

export const BlockId = Extension.create({
  name: 'inkwellBlockId',

  addGlobalAttributes() {
    return [
      {
        types: ID_TYPES,
        attributes: {
          [BLOCK_ID_ATTR]: {
            default: null,
            keepOnSplit: false,
            parseHTML: () => null,
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdKey,
        appendTransaction(trs, _old, state) {
          if (!trs.some((tr) => tr.docChanged && mayAffectBlocks(tr))) return null;
          return assignBlockIds(state);
        },
      }),
    ];
  },

  onCreate() {
    const tr = assignBlockIds(this.editor.state);
    if (tr) this.editor.view.dispatch(tr);
  },
});
