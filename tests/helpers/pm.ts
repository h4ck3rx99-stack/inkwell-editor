import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection, type Plugin } from '@tiptap/pm/state';
import { history } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { BlockId } from '@/editor/extensions/block-id';
import { createSuggestionsPlugin } from '@/editor/suggestions-plugin';

export const schema = getSchema([StarterKit, BlockId]);

/** A doc of paragraphs with deterministic block ids b0, b1, … */
export function makeDoc(...paragraphs: string[]): PMNode {
  return schema.node(
    'doc',
    null,
    paragraphs.map((t, i) => schema.node('paragraph', { bid: `b${i}` }, t ? [schema.text(t)] : [])),
  );
}

export function makeState(doc: PMNode, extra: Plugin[] = []): EditorState {
  const plugin = createSuggestionsPlugin({ onHover: () => {}, onClick: () => {}, onKeyDown: () => false });
  return EditorState.create({ doc, plugins: [plugin, history(), ...extra], selection: TextSelection.atStart(doc) });
}

/** Document position of the first occurrence of `needle` (inside a paragraph). */
export function posOf(doc: PMNode, needle: string, occurrence = 0): number {
  let found = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.isText) {
      let idx = node.text!.indexOf(needle);
      while (idx !== -1) {
        if (seen === occurrence) {
          found = pos + idx;
          return false;
        }
        seen++;
        idx = node.text!.indexOf(needle, idx + 1);
      }
    }
    return true;
  });
  if (found === -1) throw new Error(`"${needle}" not found`);
  return found;
}
