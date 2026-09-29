import { describe, expect, it } from 'vitest';
import { resolveSpan } from '@/server/ai/resolve';
import { MalformedOutputError, extractJson, parseModelOutput, type ModelIssue } from '@/server/ai/model-output';
import { isOversizedEdit, validateIssues } from '@/server/ai/validate';
import { CATEGORIES } from '@/suggestions/model';

describe('span resolution', () => {
  it('resolves an exact unique match', () => {
    expect(resolveSpan('He go to school.', 'go')).toEqual({ ok: true, start: 3, end: 5, method: 'exact' });
  });

  it('disambiguates duplicate occurrences with the prefix', () => {
    const text = 'Their dog and their cat.';
    const r = resolveSpan(text, 'heir', 'dog and t');
    expect(r).toMatchObject({ ok: true, start: 15 });
  });

  it('uses an empty prefix to mean the start of the text', () => {
    expect(resolveSpan('teh cat saw teh dog', 'teh', '')).toMatchObject({ ok: true, start: 0 });
  });

  it('reports ambiguity when the prefix cannot decide', () => {
    expect(resolveSpan('a teh b teh c', 'teh', 'zzz')).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('falls back to whitespace- and quote-normalized matching', () => {
    const text = 'She said “dont   go” twice.';
    const r = resolveSpan(text, '"dont go"', 'She said ');
    expect(r).toMatchObject({ ok: true, method: 'normalized' });
    if (r.ok) expect(text.slice(r.start, r.end)).toBe('“dont   go”');
  });

  it('reports not_found for text that is not there', () => {
    expect(resolveSpan('Hello world.', 'goodbye')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('detects spans that cross from the previous block into this one', () => {
    const r = resolveSpan('world is round.', 'hello world', '', 'I said hello');
    expect(r).toEqual({ ok: false, reason: 'crosses_boundary' });
  });

  it('rejects spans containing a paragraph break', () => {
    expect(resolveSpan('a\n\nb', 'a\n\nb')).toEqual({ ok: false, reason: 'crosses_boundary' });
  });
});

describe('model output parsing (Zod)', () => {
  const good = { original: 'teh', prefix: '', replacements: ['the'], category: 'spelling', severity: 'error', title: 'Spelling', explanation: 'Typo.', confidence: 0.9 };

  it('parses valid output', () => {
    const out = parseModelOutput(JSON.stringify({ issues: [good] }));
    expect(out.issues).toHaveLength(1);
    expect(out.invalid).toBe(0);
  });

  it('extracts JSON from code fences and surrounding prose', () => {
    expect(extractJson('Here you go:\n```json\n{"issues": []}\n```')).toEqual({ issues: [] });
    expect(extractJson('Sure! {"issues": []} Hope that helps.')).toEqual({ issues: [] });
  });

  it('rejects empty output', () => {
    expect(() => parseModelOutput('   ')).toThrow(MalformedOutputError);
  });

  it('rejects truncated / invalid JSON', () => {
    expect(() => parseModelOutput('{"issues": [{"original": "unterminated')).toThrow(MalformedOutputError);
  });

  it('rejects a wrong envelope shape', () => {
    expect(() => parseModelOutput('{"problems": []}')).toThrow(MalformedOutputError);
    expect(() => parseModelOutput('"just a string"')).toThrow(MalformedOutputError);
  });

  it('drops partial or invalid issues but keeps valid ones', () => {
    const out = parseModelOutput(
      JSON.stringify({
        issues: [
          good,
          { original: 'x' }, // partial
          { ...good, category: 'vibes' }, // unknown category
          { ...good, confidence: 150 }, // out of range
          { ...good, original: '' }, // empty span
        ],
      }),
    );
    expect(out.issues).toHaveLength(1);
    expect(out.invalid).toBe(4);
  });

  it('normalizes percentage confidences', () => {
    expect(parseModelOutput(JSON.stringify({ issues: [{ ...good, confidence: 85 }] })).issues[0]!.confidence).toBeCloseTo(0.85);
  });
});

describe('issue validation', () => {
  const all = new Set(CATEGORIES);
  const issue = (o: Partial<ModelIssue>): ModelIssue => ({
    original: 'teh', prefix: '', replacements: ['the'], category: 'spelling', severity: 'error', title: 'Spelling', explanation: 'Typo.', confidence: 0.9, ...o,
  });
  const opts = { sensitivity: 'balanced' as const, categories: all, protectedRanges: [] };

  it('keeps a proportionate fix and computes offsets', () => {
    const r = validateIssues('I saw teh cat.', [issue({})], opts);
    expect(r.issues).toEqual([expect.objectContaining({ start: 6, end: 9, original: 'teh', replacements: ['the'] })]);
  });

  it('rejects a replacement identical to the original', () => {
    const r = validateIssues('I saw the cat.', [issue({ original: 'the', replacements: ['the'] })], opts);
    expect(r.issues).toHaveLength(0);
    expect(r.dropped.identical).toBe(1);
  });

  it('rejects oversized spelling/grammar edits', () => {
    expect(isOversizedEdit('teh', 'the')).toBe(false);
    expect(isOversizedEdit('could of', 'could have')).toBe(false);
    expect(isOversizedEdit('the cat', 'a completely different phrase')).toBe(true);
    const r = validateIssues('I saw the cat today.', [issue({ original: 'the cat', replacements: ['a completely different phrase'], category: 'grammar' })], opts);
    expect(r.dropped.oversized_edit).toBe(1);
  });

  it('rejects rewrites longer than one sentence', () => {
    const r = validateIssues('This is unclear stuff.', [issue({ original: 'unclear stuff', replacements: ['clear. And more.'], category: 'clarity', severity: 'improvement' })], opts);
    expect(r.dropped.multi_sentence).toBe(1);
  });

  it('rejects anything touching URLs or code', () => {
    const text = 'See https://exmaple.com and `lenght` here.';
    const r = validateIssues(text, [issue({ original: 'exmaple', replacements: ['example'] }), issue({ original: 'lenght', replacements: ['length'] })], opts);
    expect(r.issues).toHaveLength(0);
    expect(r.dropped.protected).toBe(2);
  });

  it('respects caller-supplied protected ranges (inline code marks)', () => {
    const r = validateIssues('call fooo now', [issue({ original: 'fooo', replacements: ['foo'] })], { ...opts, protectedRanges: [{ start: 5, end: 9 }] });
    expect(r.dropped.protected).toBe(1);
  });

  it('filters by the sensitivity confidence threshold', () => {
    const text = 'I saw teh cat.';
    expect(validateIssues(text, [issue({ confidence: 0.7 })], { ...opts, sensitivity: 'conservative' }).issues).toHaveLength(0);
    expect(validateIssues(text, [issue({ confidence: 0.7 })], { ...opts, sensitivity: 'balanced' }).issues).toHaveLength(1);
  });

  it('drops disabled categories', () => {
    const r = validateIssues('I saw teh cat.', [issue({})], { ...opts, categories: new Set(['grammar'] as const) });
    expect(r.dropped.category_disabled).toBe(1);
  });

  it('does not allow advisory (no replacement) spelling issues', () => {
    const r = validateIssues('I saw teh cat.', [issue({ replacements: [] })], opts);
    expect(r.dropped.advisory_not_allowed).toBe(1);
  });

  it('removes overlaps and caps the count per block', () => {
    const words = Array.from({ length: 20 }, (_, i) => `wrd${i}x`).join(' ');
    const many = Array.from({ length: 20 }, (_, i) => issue({ original: `wrd${i}x`, replacements: [`wrd${i}`], prefix: '' }));
    const r = validateIssues(words, [...many, issue({ original: 'wrd0x wrd1x', replacements: ['wrd0 wrd1'], category: 'grammar' })], opts);
    expect(r.issues.length).toBe(8);
    expect(r.dropped.cap).toBeGreaterThan(0);
    for (let i = 1; i < r.issues.length; i++) expect(r.issues[i]!.start).toBeGreaterThanOrEqual(r.issues[i - 1]!.end);
  });

  it('drops unresolvable spans', () => {
    const r = validateIssues('Hello there.', [issue({ original: 'nonexistent' })], opts);
    expect(r.dropped.not_found).toBe(1);
  });
});
