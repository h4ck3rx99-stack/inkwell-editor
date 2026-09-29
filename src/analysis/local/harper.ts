/**
 * Adapter around harper.js (a grammar checker compiled to WebAssembly).
 * Runs entirely in-process; the only I/O is loading the WASM binary, which the
 * caller supplies as a same-origin static URL. No user text leaves the device.
 */
import { LocalLinter, Dialect as HarperDialect, SuggestionKind, createBinaryModuleFromUrl, type Lint } from 'harper.js';
import type { Dialect } from '@/settings/model';

export interface EngineLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  rule: string;
  message: string;
  replacements: string[];
}

export interface GrammarEngine {
  lint(text: string): Promise<EngineLint[]>;
  setDialect(dialect: Dialect): Promise<void>;
  setWords(words: string[]): Promise<void>;
}

const DIALECTS: Record<Dialect, HarperDialect> = {
  'en-US': HarperDialect.American,
  'en-GB': HarperDialect.British,
  'en-AU': HarperDialect.Australian,
  'en-CA': HarperDialect.Canadian,
  'en-IN': HarperDialect.Indian,
};

/** Rules whose behavior our own deterministic rules already cover with better-tuned skip logic. */
const DISABLED_RULES = ['SentenceCapitalization', 'LongSentences', 'SpelledNumbers'];

export async function createHarperEngine(binaryUrl: string, dialect: Dialect, words: string[]): Promise<GrammarEngine> {
  const binary = createBinaryModuleFromUrl(binaryUrl, 'slim');
  let currentDialect = dialect;
  let currentWords = [...words];

  const make = async () => {
    const linter = new LocalLinter({ binary, dialect: DIALECTS[currentDialect] });
    await linter.setup();
    const config = await linter.getLintConfig();
    let changed = false;
    for (const rule of DISABLED_RULES) {
      if (rule in config && config[rule] !== false) {
        config[rule] = false;
        changed = true;
      }
    }
    if (changed) await linter.setLintConfig(config);
    if (currentWords.length) await linter.importWords(currentWords);
    return linter;
  };

  let linter = await make();

  return {
    async lint(text) {
      const organized = await linter.organizedLints(text, { language: 'plaintext' });
      const out: EngineLint[] = [];
      for (const [rule, lints] of Object.entries(organized)) {
        for (const lint of lints) {
          const mapped = mapLint(text, rule, lint);
          if (mapped) out.push(mapped);
        }
      }
      return out;
    },
    async setDialect(d) {
      if (d === currentDialect) return;
      currentDialect = d;
      await linter.setDialect(DIALECTS[d]);
    },
    async setWords(next) {
      const removed = currentWords.some((w) => !next.includes(w));
      const added = next.filter((w) => !currentWords.includes(w));
      currentWords = [...next];
      // harper can import but not forget words, so a removal rebuilds the linter.
      if (removed) linter = await make();
      else if (added.length) await linter.importWords(added);
    },
  };
}

function mapLint(text: string, rule: string, lint: Lint): EngineLint | null {
  const span = lint.span();
  let { start, end } = span;
  const problem = lint.get_problem_text();
  if (text.slice(start, end) !== problem) {
    // Defensive: if harper ever reports scalar-value offsets, convert them to UTF-16.
    const conv = scalarToUtf16(text);
    start = conv[start] ?? -1;
    end = conv[end] ?? -1;
    if (start < 0 || text.slice(start, end) !== problem) return null;
  }
  const replacements: string[] = [];
  for (const s of lint.suggestions()) {
    const kind = s.kind();
    const r = s.get_replacement_text();
    if (kind === SuggestionKind.Remove) replacements.push('');
    else if (kind === SuggestionKind.InsertAfter) replacements.push(problem + r);
    else replacements.push(r);
  }
  return { start, end, problem, kind: lint.lint_kind(), rule, message: lint.message(), replacements };
}

function scalarToUtf16(text: string): number[] {
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    map.push(i);
    i += ch.length;
  }
  map.push(i);
  return map;
}
