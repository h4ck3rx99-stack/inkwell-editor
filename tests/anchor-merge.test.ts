import { describe, expect, it } from 'vitest';
import { hashText } from '@/lib/hash';
import { anchorFindings, currentBlockHash, findBlock, textOfBlock, verifySuggestion } from '@/suggestions/anchor';
import { comparePriority, selectVisible } from '@/suggestions/merge';
import { dismissKeys, isDismissed } from '@/suggestions/keys';
import type { Finding, Suggestion } from '@/suggestions/model';
import { makeDoc, makeState, posOf } from './helpers/pm';

const f = (start: number, original: string, extra: Partial<Finding> = {}): Finding => ({
  start, end: start + original.length, original, replacements: ['x'], category: 'spelling', severity: 'error',
  ruleId: 'r', title: 't', confidence: 0.9, ...extra,
});

describe('stale response rejection', () => {
  it('anchors findings when the block text still matches the analyzed hash', () => {
    const doc = makeDoc('Hello teh world');
    const hash = currentBlockHash(doc, 'b0')!;
    const out = anchorFindings(doc, 'b0', hash, [f(6, 'teh')], { source: 'ai', revision: 1 });
    expect(out).toHaveLength(1);
    expect(doc.textBetween(out![0]!.from, out![0]!.to)).toBe('teh');
  });

  it('rejects the entire response when the block changed during the request', () => {
    const analyzed = 'Hello teh world';
    const hash = hashText(analyzed);
    // The user kept typing while the request was in flight.
    let state = makeState(makeDoc(analyzed));
    state = state.apply(state.tr.insertText('Oh, ', 1));
    expect(anchorFindings(state.doc, 'b0', hash, [f(6, 'teh')], { source: 'ai', revision: 1 })).toBeNull();
  });

  it('rejects findings for a block that no longer exists', () => {
    const doc = makeDoc('Hello');
    expect(anchorFindings(doc, 'missing', hashText('Hello'), [f(0, 'Hello')], { source: 'local', revision: 0 })).toBeNull();
  });

  it('drops individual findings whose text does not match the span', () => {
    const doc = makeDoc('Hello teh world');
    const hash = currentBlockHash(doc, 'b0')!;
    const out = anchorFindings(doc, 'b0', hash, [f(6, 'teh'), f(0, 'Nope'), { ...f(12, 'world'), end: 99 }], { source: 'ai', revision: 1 });
    expect(out!.map((s) => s.original)).toEqual(['teh']);
  });
});

describe('verifySuggestion', () => {
  const base = (doc: ReturnType<typeof makeDoc>, original: string, from: number): Pick<Suggestion, 'from' | 'to' | 'original' | 'blockId'> => ({
    from, to: from + original.length, original, blockId: 'b0',
  });

  it('accepts a suggestion whose text is at its range', () => {
    const doc = makeDoc('one teh two');
    const from = posOf(doc, 'teh');
    expect(verifySuggestion(doc, base(doc, 'teh', from))).toEqual({ from, to: from + 3 });
  });

  it('relocates within the block when the text occurs exactly once', () => {
    const doc = makeDoc('one teh two');
    const actual = posOf(doc, 'teh');
    expect(verifySuggestion(doc, base(doc, 'teh', actual - 2))).toEqual({ from: actual, to: actual + 3 });
  });

  it('refuses to relocate when the text is ambiguous', () => {
    const doc = makeDoc('teh and teh');
    expect(verifySuggestion(doc, base(doc, 'teh', 3))).toBeNull();
  });

  it('refuses when the text is gone', () => {
    const doc = makeDoc('one the two');
    expect(verifySuggestion(doc, base(doc, 'teh', 5))).toBeNull();
  });

  it('extracts block text with one character per position (hard breaks included)', () => {
    const { schema } = makeState(makeDoc('x')).doc.type;
    const para = schema.node('paragraph', { bid: 'b0' }, [schema.text('ab'), schema.node('hardBreak'), schema.text('cd')]);
    const doc = schema.node('doc', null, [para]);
    const block = findBlock(doc, 'b0')!;
    const text = textOfBlock(block.node);
    expect(text).toBe('ab\ncd');
    expect(doc.textBetween(block.pos + 1 + 3, block.pos + 1 + 5)).toBe('cd');
  });
});

describe('merge priority', () => {
  const s = (from: number, to: number, extra: Partial<Suggestion> = {}): Suggestion => ({
    id: `${from}-${to}-${extra.source ?? 'local'}-${extra.severity ?? 'error'}`, blockId: 'b0', from, to, original: 'x'.repeat(to - from), replacements: ['y'],
    category: 'spelling', severity: 'error', source: 'local', title: 't', confidence: 0.8, blockHash: 'h', revision: 0, status: 'open', ...extra,
  });

  it('error beats improvement beats style', () => {
    expect(comparePriority(s(0, 3, { severity: 'error' }), s(0, 3, { severity: 'improvement' }))).toBeGreaterThan(0);
    expect(comparePriority(s(0, 3, { severity: 'improvement' }), s(0, 3, { severity: 'style' }))).toBeGreaterThan(0);
  });

  it('then higher confidence, then the narrower span', () => {
    expect(comparePriority(s(0, 3, { confidence: 0.9 }), s(0, 3, { confidence: 0.8 }))).toBeGreaterThan(0);
    expect(comparePriority(s(0, 2), s(0, 5))).toBeGreaterThan(0);
  });

  it('selects a non-overlapping visible set', () => {
    const visible = selectVisible([
      s(0, 5, { severity: 'style', confidence: 0.99 }),
      s(3, 8, { severity: 'error', confidence: 0.6 }),
      s(10, 12),
    ]);
    expect(visible.map((v) => [v.from, v.to])).toEqual([[3, 8], [10, 12]]);
  });

  it('dedupes identical fixes from local and AI, keeping local', () => {
    const visible = selectVisible([s(0, 3, { source: 'ai' }), s(0, 3, { source: 'local' })]);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.source).toBe('local');
  });

  it('keeps adjacent (touching but not overlapping) suggestions', () => {
    expect(selectVisible([s(0, 3), s(3, 6)])).toHaveLength(2);
  });
});

describe('dismissal keys', () => {
  const sug = { blockHash: 'h1', original: 'teh', ruleId: 'harper:Spelling', category: 'spelling' as const, source: 'local' as const };

  it('matches the same finding re-reported for the same block text', () => {
    const text = 'One teh two. Three four.';
    const dismissed = new Set(dismissKeys(sug, text, 4));
    expect(isDismissed(dismissed, sug, text, 4)).toBe(true);
  });

  it('still matches after an edit to a different sentence of the paragraph', () => {
    const text = 'One teh two. Three four.';
    const dismissed = new Set(dismissKeys(sug, text, 4));
    const edited = 'One teh two. Three four five six.';
    expect(isDismissed(dismissed, { ...sug, blockHash: hashText(edited) }, edited, 4)).toBe(true);
  });

  it('does not match a different rule on the same word', () => {
    const text = 'One teh two.';
    const dismissed = new Set(dismissKeys(sug, text, 4));
    expect(isDismissed(dismissed, { ...sug, ruleId: 'ai:spelling' }, text, 4)).toBe(false);
  });
});
