import { describe, expect, it } from 'vitest';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { undo } from '@tiptap/pm/history';
import { hashText } from '@/lib/hash';
import { anchorFindings, textOfBlock, findBlock } from '@/suggestions/anchor';
import type { Finding, Suggestion } from '@/suggestions/model';
import { displayedSuggestions, getSuggestionsState, mapSuggestionRange, suggestionsKey, type SuggestionsMeta } from '@/editor/suggestions-plugin';
import { makeDoc, makeState, posOf } from './helpers/pm';

function finding(text: string, original: string, replacement: string, extra: Partial<Finding> = {}, occurrence = 0): Finding {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(original, start + 1);
  return {
    start, end: start + original.length, original, replacements: [replacement], category: 'spelling', severity: 'error',
    ruleId: 'test:rule', title: 'Spelling', confidence: 0.9, ...extra,
  };
}

function addFindings(state: EditorState, blockId: string, findings: Finding[], source: 'local' | 'ai' = 'local'): EditorState {
  const block = findBlock(state.doc, blockId)!;
  const text = textOfBlock(block.node);
  const anchored = anchorFindings(state.doc, blockId, hashText(text), findings, { source, revision: 0 })!;
  const meta: SuggestionsMeta = { type: 'setBlock', blockId, source, suggestions: anchored };
  return state.apply(state.tr.setMeta(suggestionsKey, meta));
}

function moveCursorToEnd(state: EditorState) {
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

function only(state: EditorState): Suggestion {
  const list = displayedSuggestions(state);
  expect(list).toHaveLength(1);
  return list[0]!;
}

const TEXT = 'The quick teh fox jumps.';

describe('suggestion range mapping', () => {
  const setup = () => moveCursorToEnd(addFindings(moveCursorToEnd(makeState(makeDoc(TEXT, 'Second paragraph.'))), 'b0', [finding(TEXT, 'teh', 'the')]));

  it('anchors to the right document positions', () => {
    const state = setup();
    const s = only(state);
    expect(state.doc.textBetween(s.from, s.to)).toBe('teh');
    expect(getSuggestionsState(state).deco.find()).toHaveLength(1);
  });

  it('shifts when text is inserted before the span', () => {
    let state = setup();
    const before = only(state);
    state = state.apply(state.tr.insertText('very ', posOf(state.doc, 'quick')));
    const after = only(state);
    expect(after.from).toBe(before.from + 5);
    expect(state.doc.textBetween(after.from, after.to)).toBe('teh');
    expect(getSuggestionsState(state).deco.find()).toHaveLength(1);
  });

  it('is unaffected by edits after the span', () => {
    let state = setup();
    const before = only(state);
    state = state.apply(state.tr.insertText('brown ', posOf(state.doc, 'fox')));
    expect(only(state)).toMatchObject({ from: before.from, to: before.to });
  });

  it('shifts when text is deleted before the span', () => {
    let state = setup();
    const before = only(state);
    const q = posOf(state.doc, 'The ');
    state = state.apply(state.tr.delete(q, q + 4));
    const after = only(state);
    expect(after.from).toBe(before.from - 4);
    expect(state.doc.textBetween(after.from, after.to)).toBe('teh');
  });

  it('goes stale when an edit lands inside the span', () => {
    let state = setup();
    const s = only(state);
    state = state.apply(state.tr.insertText('x', s.from + 1));
    expect(displayedSuggestions(state)).toHaveLength(0);
    expect(getSuggestionsState(state).deco.find()).toHaveLength(0);
  });

  it('goes stale when a deletion overlaps the span', () => {
    let state = setup();
    const s = only(state);
    state = state.apply(state.tr.delete(s.from - 2, s.from + 1));
    expect(displayedSuggestions(state)).toHaveLength(0);
  });

  it('goes stale when a word character is typed touching the span', () => {
    let state = setup();
    const s = only(state);
    state = state.apply(state.tr.insertText('s', s.to));
    expect(displayedSuggestions(state)).toHaveLength(0);
  });

  it('survives a space or punctuation typed right after the span', () => {
    let state = setup();
    const s = only(state);
    state = state.apply(state.tr.insertText(',', s.to));
    expect(only(state)).toMatchObject({ from: s.from, to: s.to });
  });

  it('goes stale when the character just before the span is deleted', () => {
    let state = setup();
    const s = only(state);
    state = state.apply(state.tr.delete(s.from - 1, s.from));
    expect(displayedSuggestions(state)).toHaveLength(0);
  });

  it('is removed when its whole block is deleted', () => {
    let state = setup();
    const block = findBlock(state.doc, 'b0')!;
    state = state.apply(state.tr.delete(block.pos, block.pos + block.node.nodeSize));
    expect(displayedSuggestions(state)).toHaveLength(0);
  });

  it('maps through a multi-step transaction', () => {
    let state = setup();
    const s = only(state);
    const tr = state.tr.insertText('A ', 1).insertText('!', state.doc.content.size - 1);
    state = state.apply(tr);
    const after = only(state);
    expect(after.from).toBe(s.from + 2);
    expect(state.doc.textBetween(after.from, after.to)).toBe('teh');
  });

  it('never enters the document or the undo history', () => {
    let state = makeState(makeDoc(TEXT));
    state = moveCursorToEnd(state);
    const json = JSON.stringify(state.doc.toJSON());
    state = addFindings(state, 'b0', [finding(TEXT, 'teh', 'the')]);
    expect(JSON.stringify(state.doc.toJSON())).toBe(json);
    // Nothing to undo: the suggestion transaction was not recorded as an edit.
    let undone = false;
    undo(state, () => {
      undone = true;
    });
    expect(undone).toBe(false);
  });
});

describe('mapSuggestionRange (pure)', () => {
  it('returns null for an overlapping replace', () => {
    const state = makeState(makeDoc(TEXT));
    const from = posOf(state.doc, 'teh');
    const tr = state.tr.insertText('XYZ', from, from + 3);
    expect(mapSuggestionRange({ from, to: from + 3 }, tr)).toBeNull();
  });
});

describe('overlap priority and dedupe in the plugin', () => {
  const text = 'We could of gone there.';

  it('shows only one of two overlapping suggestions, by severity', () => {
    let state = moveCursorToEnd(makeState(makeDoc(text)));
    state = addFindings(state, 'b0', [finding(text, 'could of', 'could have', { category: 'grammar', severity: 'error', confidence: 0.7 })], 'ai');
    state = addFindings(state, 'b0', [finding(text, 'of', 'have', { category: 'clarity', severity: 'style', confidence: 0.95 })], 'local');
    expect(only(state).original).toBe('could of');
    expect(getSuggestionsState(state).items.size).toBe(2);
  });

  it('reveals the shadowed suggestion when the winner is removed', () => {
    let state = moveCursorToEnd(makeState(makeDoc(text)));
    state = addFindings(state, 'b0', [finding(text, 'could of', 'could have', { category: 'grammar' })], 'ai');
    state = addFindings(state, 'b0', [finding(text, 'of', 'have', { severity: 'style', category: 'clarity' })], 'local');
    const winner = only(state);
    state = state.apply(state.tr.setMeta(suggestionsKey, { type: 'remove', ids: [winner.id] } satisfies SuggestionsMeta));
    expect(only(state).original).toBe('of');
  });

  it('dedupes the same fix reported by local and AI', () => {
    let state = moveCursorToEnd(makeState(makeDoc(TEXT)));
    state = addFindings(state, 'b0', [finding(TEXT, 'teh', 'the')], 'local');
    state = addFindings(state, 'b0', [finding(TEXT, 'teh', 'the')], 'ai');
    expect(only(state).source).toBe('local');
  });

  it('keeps identity (no re-render) when the same finding is re-reported', () => {
    let state = moveCursorToEnd(makeState(makeDoc(TEXT)));
    state = addFindings(state, 'b0', [finding(TEXT, 'teh', 'the')]);
    const first = only(state);
    state = addFindings(state, 'b0', [finding(TEXT, 'teh', 'the')]);
    expect(only(state).id).toBe(first.id);
  });

  it('never shows overlapping suggestions', () => {
    const t = 'alpha beta gamma delta';
    let state = moveCursorToEnd(makeState(makeDoc(t)));
    state = addFindings(state, 'b0', [
      finding(t, 'alpha beta', 'x', { confidence: 0.7 }),
      finding(t, 'beta gamma', 'y', { confidence: 0.9 }),
      finding(t, 'gamma delta', 'z', { confidence: 0.8 }),
    ]);
    const list = displayedSuggestions(state);
    for (let i = 1; i < list.length; i++) expect(list[i]!.from).toBeGreaterThanOrEqual(list[i - 1]!.to);
    expect(list.map((s) => s.original)).toEqual(['beta gamma']);
  });
});

describe('cursor deferral', () => {
  it('does not show a suggestion created under the caret until the caret leaves', () => {
    const text = 'I am writting';
    let state = makeState(makeDoc(text));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)));
    state = addFindings(state, 'b0', [finding(text, 'writting', 'writing')]);
    expect(displayedSuggestions(state)).toHaveLength(0);
    expect(getSuggestionsState(state).deco.find()).toHaveLength(0);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    expect(only(state).original).toBe('writting');
    expect(getSuggestionsState(state).deco.find()).toHaveLength(1);
  });

  it('reveals the suggestion when a space is typed after the word', () => {
    const text = 'I am writting';
    let state = makeState(makeDoc(text));
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)));
    state = addFindings(state, 'b0', [finding(text, 'writting', 'writing')]);
    state = state.apply(state.tr.insertText(' ', end));
    expect(only(state).original).toBe('writting');
  });
});
