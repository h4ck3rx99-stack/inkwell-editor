import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runRules } from '@/analysis/local/rules';
import { analyzeBlock, rankSpelling, skipSpelling } from '@/analysis/local/analyze';
import { createHarperEngine, type GrammarEngine } from '@/analysis/local/harper';
import { findProtectedRanges, splitSentences } from '@/lib/text';
import type { Sensitivity } from '@/settings/model';

function rules(text: string, opts: { cursor?: number | null; sensitivity?: Sensitivity } = {}) {
  return runRules({ text, cursorOffset: opts.cursor ?? null, protectedRanges: findProtectedRanges(text), sensitivity: opts.sensitivity ?? 'balanced' });
}
const ids = (text: string, o?: Parameters<typeof rules>[1]) => rules(text, o).findings.map((f) => `${f.ruleId}:${f.original}`);

describe('deterministic rules', () => {
  it('flags repeated words (and keeps the first word’s casing)', () => {
    const f = rules('The the dog barked.').findings.find((x) => x.ruleId === 'local:repeated-word')!;
    expect(f).toMatchObject({ original: 'The the', replacements: ['The'] });
  });

  it('allows legitimate doubles like "had had" and "that that"', () => {
    expect(ids('She had had enough. He said that that was fine.')).not.toContain('local:repeated-word:had had');
    expect(ids('She had had enough. He said that that was fine.')).not.toContain('local:repeated-word:that that');
  });

  it('checks a/an agreement by sound, not letter', () => {
    const r = ids('I ate a apple and an banana. It was an hour, a university, an MBA and a one-off.');
    expect(r).toContain('local:a-an:a');
    expect(r).toContain('local:a-an:an');
    expect(rules('It was an hour, a university, an MBA and a one-off, a European trip.').findings.filter((f) => f.ruleId === 'local:a-an')).toHaveLength(0);
  });

  it('capitalizes sentence starts and the pronoun i', () => {
    const r = rules("the cat sat. i think i'm right.").findings;
    expect(r.find((f) => f.original === 'the')!.replacements).toEqual(['The']);
    expect(r.filter((f) => f.original === 'i').map((f) => f.replacements[0])).toContain('I');
    expect(r.find((f) => f.original === "i'm")!.replacements).toEqual(["I'm"]);
  });

  it('does not treat i.e., e.g. or (i) as the pronoun', () => {
    expect(ids('Use a tool, i.e. a hammer. (i) First item.').some((x) => x.startsWith('local:capitalization:i'))).toBe(false);
  });

  it('does not capitalize brand-style words like iPhone or after abbreviations', () => {
    expect(ids('iPhone sales rose. Talk to Dr. smith later.').filter((x) => x.includes('capitalization'))).toEqual([]);
  });

  it('flags double spaces, missing spaces and spaces before punctuation', () => {
    const r = ids('Hello  world ,this is wrong.Next one,and done ; ok');
    expect(r).toContain('local:double-space:  ');
    expect(r).toContain('local:space-before-punct: ;');
    expect(r).toContain('local:missing-space:,');
    expect(r).toContain('local:missing-space:.');
    // Space on the wrong side of the comma moves after it.
    const moved = rules('Hello world ,this').findings.find((f) => f.ruleId === 'local:space-before-punct')!;
    expect(moved).toMatchObject({ original: ' ,', replacements: [', '] });
  });

  it('does not flag times, ratios, decimals, domains or version numbers', () => {
    const r = ids('Meet at 10:30 with ratio 3:2, pi is 3.14, see example.com and Node.js v1.2.3.');
    expect(r.filter((x) => x.includes('missing-space'))).toEqual([]);
  });

  it('flags unmatched brackets and quotes', () => {
    expect(ids('This (is unclosed. And this] too.')).toEqual(expect.arrayContaining(['local:unmatched:(', 'local:unmatched:]']));
    expect(ids('He said "hello and left.')).toContain('local:unmatched:"');
  });

  it('does not flag an opener the writer is still typing inside', () => {
    const text = 'This is a thought (still typing';
    const out = rules(text, { cursor: text.length });
    expect(out.findings.filter((f) => f.ruleId === 'local:unmatched')).toHaveLength(0);
    expect(out.cursorSuppressed).toBe(true);
  });

  it('suggests trimming filler words and wordy phrases', () => {
    const r = rules('We did it in order to win, due to the fact that it was really important.').findings;
    expect(r.find((f) => f.original === 'in order to')!.replacements).toEqual(['to']);
    expect(r.find((f) => f.original === 'due to the fact that')!.replacements).toEqual(['because']);
    expect(r.find((f) => f.original === 'really ')!.replacements).toEqual(['']);
  });

  it('keeps sentence-initial intensifiers and fixed phrases alone', () => {
    const r = ids('Very well. At the very least, thank you very much.');
    expect(r.filter((x) => x.includes('filler'))).toEqual([]);
  });

  it('flags very long sentences as an advisory', () => {
    const long = `${Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')}.`;
    const f = rules(long).findings.find((x) => x.ruleId === 'local:long-sentence')!;
    expect(f.replacements).toEqual([]);
    expect(f.category).toBe('readability');
  });

  it('flags repeated sentence starters within a paragraph', () => {
    const r = ids('The cat sat. The dog ran. The bird flew.');
    expect(r).toContain('local:repeated-starter:The');
    expect(ids('The cat sat. A dog ran. The bird flew.')).not.toContain('local:repeated-starter:The');
  });

  it('never flags inside URLs, emails or code', () => {
    const r = ids('Visit https://example.com/the the or mail me@teh.org and run `a apple` now.');
    expect(r.filter((x) => !x.includes('long-sentence'))).toEqual([]);
  });
});

describe('text utilities', () => {
  it('splits sentences without breaking on abbreviations or decimals', () => {
    const s = splitSentences('Dr. Smith paid $3.50 for it. Then he left! Did he? Yes.');
    expect(s.map((x) => x.text)).toEqual(['Dr. Smith paid $3.50 for it.', 'Then he left!', 'Did he?', 'Yes.']);
  });

  it('ranks spelling candidates by plausibility', () => {
    expect(rankSpelling('writting', ['writhing', 'witting', 'writing'])[0]).toBe('writing');
    expect(rankSpelling('recieved', ['relieved', 'received', 'receive'])[0]).toBe('received');
  });

  it('skips acronyms, numbers, proper nouns and dictionary words for spelling', () => {
    const text = 'We met Zorblat at NASA in 2024 and saw qux3.';
    const at = (w: string) => [text.indexOf(w), text.indexOf(w) + w.length] as const;
    expect(skipSpelling(text, ...at('NASA'), new Set())).toBe(true);
    expect(skipSpelling(text, ...at('qux3'), new Set())).toBe(true);
    expect(skipSpelling(text, ...at('Zorblat'), new Set())).toBe(true);
    expect(skipSpelling('I like frobnicate.', 7, 17, new Set(['frobnicate']))).toBe(true);
    expect(skipSpelling('I like frobnicate.', 7, 17, new Set())).toBe(false);
  });
});

describe('harper.js engine (real WASM)', () => {
  let engine: GrammarEngine;

  beforeAll(async () => {
    const dist = join(dirname(fileURLToPath(import.meta.resolve('harper.js'))));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('harper-test:')) {
        const bytes = await readFile(join(dist, url.slice('harper-test:'.length)));
        return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    engine = await createHarperEngine('harper-test:harper_wasm_slim_bg.wasm', 'en-US', []);
  }, 60_000);

  const analyze = (text: string, cursorOffset: number | null = null, dictionary = new Set<string>()) =>
    analyzeBlock({ blockId: 'b', text, hash: 'h', cursorOffset, codeRanges: [] }, { sensitivity: 'balanced', dictionary }, engine);

  it('finds spelling mistakes with a sensible first suggestion', async () => {
    const r = await analyze('I recieved your message yesterday.');
    const f = r.findings.find((x) => x.original === 'recieved')!;
    expect(f.category).toBe('spelling');
    expect(f.replacements[0]).toBe('received');
  });

  it('stays quiet on clean text', async () => {
    const r = await analyze('This is a perfectly ordinary sentence, and it should not be flagged at all.');
    expect(r.findings).toEqual([]);
  });

  it('does not flag the word being typed (cursor touching it)', async () => {
    const text = 'I am writting';
    const typing = await analyze(text, text.length);
    expect(typing.findings.find((f) => f.original === 'writting')).toBeUndefined();
    expect(typing.cursorSuppressed).toBe(true);
    const done = await analyze(`${text} `, text.length + 1);
    expect(done.findings.find((f) => f.original === 'writting')).toBeDefined();
  });

  it('respects the user dictionary', async () => {
    const r = await analyze('The frobnicator worked.', null, new Set(['frobnicator']));
    expect(r.findings.find((f) => f.original === 'frobnicator')).toBeUndefined();
    await engine.setWords(['frobnicator']);
    const r2 = await analyze('The frobnicator worked.');
    expect(r2.findings.find((f) => f.original === 'frobnicator')).toBeUndefined();
    await engine.setWords([]);
    const r3 = await analyze('The frobnicator worked.');
    expect(r3.findings.find((f) => f.original === 'frobnicator')).toBeDefined();
  });

  it('follows the dialect', async () => {
    await engine.setDialect('en-GB');
    const gb = await analyze('The colour of the organisation.');
    expect(gb.findings.filter((f) => f.category === 'spelling')).toEqual([]);
    await engine.setDialect('en-US');
    const us = await analyze('The colour of the organisation.');
    expect(us.findings.some((f) => f.original === 'colour')).toBe(true);
  });

  it('skips URLs, emails, inline code ranges and acronyms', async () => {
    const text = 'See https://exmaple.com, mail joe@exmaple.com, run fooo and ask NASAA.';
    const codeStart = text.indexOf('fooo');
    const r = await analyzeBlock(
      { blockId: 'b', text, hash: 'h', cursorOffset: null, codeRanges: [{ start: codeStart, end: codeStart + 4 }] },
      { sensitivity: 'balanced', dictionary: new Set() },
      engine,
    );
    expect(r.findings.map((f) => f.original)).toEqual([]);
  });

  it('produces offsets that match the text exactly (including after emoji)', async () => {
    const text = 'Party 🎉 time with teh crew.';
    const r = await analyze(text);
    const f = r.findings.find((x) => x.original === 'teh')!;
    expect(text.slice(f.start, f.end)).toBe('teh');
  });
});
