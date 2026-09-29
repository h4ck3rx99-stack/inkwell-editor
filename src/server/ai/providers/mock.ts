/**
 * Deterministic mock provider for tests and offline development. It behaves
 * like a model (returns `original` + `prefix`, never offsets) and supports
 * configurable latency and failure modes. Clearly labeled "Mock" in the UI.
 */
import type { Category, Severity } from '@/suggestions/model';
import { splitSentences } from '@/lib/text';
import type { MockControl } from '@/shared/ai-contract';
import { ProviderError } from '../errors';
import { abortableSleep } from '../retry';
import type { AIProvider, StructuredRequest, TextRequest, WriteTask } from './types';

interface MockRule {
  re: RegExp;
  replace: (m: RegExpExecArray) => string;
  category: Category;
  severity: Severity;
  title: string;
  explanation: string;
  confidence: number;
}

const keepCase = (src: string, rep: string) => (/^\p{Lu}/u.test(src) ? rep[0]!.toUpperCase() + rep.slice(1) : rep);

export const MOCK_RULES: MockRule[] = [
  { re: /\balot\b/gi, replace: (m) => keepCase(m[0], 'a lot'), category: 'spelling', severity: 'error', title: 'Spelling', explanation: '“A lot” is two words.', confidence: 0.95 },
  { re: /\birregardless\b/gi, replace: (m) => keepCase(m[0], 'regardless'), category: 'word-choice', severity: 'improvement', title: 'Nonstandard word', explanation: '“Regardless” is the standard form.', confidence: 0.9 },
  { re: /\b(could|should|would|must) of\b/gi, replace: (m) => `${m[1]} have`, category: 'grammar', severity: 'error', title: 'Wrong verb form', explanation: 'Use “have” after a modal verb, not “of”.', confidence: 0.93 },
  { re: /\btheir (is|are|was|were)\b/gi, replace: (m) => `${keepCase(m[0], 'there')} ${m[1]}`, category: 'grammar', severity: 'error', title: 'Wrong word', explanation: '“There” points to existence; “their” shows possession.', confidence: 0.9 },
  { re: /\bbetween you and I\b/gi, replace: (m) => keepCase(m[0], 'between you and me'), category: 'grammar', severity: 'error', title: 'Pronoun case', explanation: 'After “between”, use “me”, not “I”.', confidence: 0.88 },
  { re: /\bless (people|items|mistakes|words|things|errors)\b/gi, replace: (m) => `${keepCase(m[0], 'fewer')} ${m[1]}`, category: 'grammar', severity: 'improvement', title: 'Fewer vs. less', explanation: 'Use “fewer” for things you can count.', confidence: 0.82 },
  { re: /\butilize\b/gi, replace: (m) => keepCase(m[0], 'use'), category: 'concision', severity: 'improvement', title: 'Simpler word', explanation: '“Use” says the same thing more plainly.', confidence: 0.72 },
  { re: /\bteh\b/gi, replace: (m) => keepCase(m[0], 'the'), category: 'spelling', severity: 'error', title: 'Spelling', explanation: 'This looks like a typo for “the”.', confidence: 0.96 },
];

interface ModelIssue {
  original: string;
  prefix: string;
  replacements: string[];
  category: Category;
  severity: Severity;
  title: string;
  explanation: string;
  confidence: number;
}

export function mockCorrections(text: string): ModelIssue[] {
  const out: ModelIssue[] = [];
  for (const rule of MOCK_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      out.push({
        original: m[0],
        prefix: text.slice(Math.max(0, m.index - 30), m.index),
        replacements: [rule.replace(m)],
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        explanation: rule.explanation,
        confidence: rule.confidence,
      });
    }
  }
  return out;
}

function applyFixes(text: string): string {
  let out = text;
  for (const rule of MOCK_RULES) out = out.replace(rule.re, (...args) => rule.replace(args as unknown as RegExpExecArray));
  return out;
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bdon't\b/gi, 'do not'], [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bit's\b/gi, 'it is'],
  [/\bI'm\b/g, 'I am'], [/\bisn't\b/gi, 'is not'], [/\bdoesn't\b/gi, 'does not'], [/\bwe're\b/gi, 'we are'],
];

export function mockWrite(task: WriteTask): string {
  const text = task.text.trim();
  switch (task.action) {
    case 'improve': {
      let out = applyFixes(text).replace(/\s{2,}/g, ' ');
      out = out.charAt(0).toUpperCase() + out.slice(1);
      if (!/[.!?"”]$/.test(out)) out += '.';
      return out === text ? `${text.replace(/[.!?]$/, '')}, refined.` : out;
    }
    case 'clearer': {
      const out = applyFixes(text).replace(/\bin order to\b/gi, 'to').replace(/, and /g, '. And ');
      return out === text ? `Put simply: ${text}` : out;
    }
    case 'shorter': {
      const out = text.replace(/\b(very|really|just|basically|actually|quite) /gi, '').replace(/\bin order to\b/gi, 'to');
      if (out !== text) return out;
      const words = text.split(/\s+/);
      return words.slice(0, Math.max(3, Math.ceil(words.length * 0.6))).join(' ').replace(/[,;:]$/, '') + '.';
    }
    case 'longer':
      return `${text} This matters because it shapes how the rest of the piece is read.`;
    case 'tone': {
      let out = text;
      if (task.tone === 'formal') for (const [re, rep] of CONTRACTIONS) out = out.replace(re, rep);
      if (task.tone === 'confident') out = out.replace(/\b(I think|maybe|perhaps|probably) ?/gi, '');
      if (task.tone === 'neutral') out = out.replace(/!/g, '.');
      if (out !== text) return out.charAt(0).toUpperCase() + out.slice(1);
      const lead: Record<string, string> = { formal: 'Accordingly,', friendly: 'Honestly,', confident: 'Clearly,', neutral: 'In summary,', persuasive: 'Consider this:' };
      return `${lead[task.tone ?? 'neutral'] ?? 'Note:'} ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    case 'custom':
      return /upper ?case/i.test(task.instruction ?? '') ? text.toUpperCase() : `${text} (${(task.instruction ?? '').trim() || 'revised'})`;
    case 'explain':
      return `This passage makes one main point: ${splitSentences(text)[0]?.text ?? text} In plain terms, it sets up what comes next.`;
    case 'continue':
      return ' And so the work went on, one careful sentence at a time.';
    case 'why':
      return `Changing “${task.suggestion?.original ?? ''}” to “${task.suggestion?.replacement ?? ''}” fixes a ${task.suggestion?.title.toLowerCase() ?? 'small'} problem, so the sentence reads the way a careful reader expects.`;
    case 'summarize':
    case 'summarize-chunk': {
      const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      const points = paras.slice(0, 5).map((p) => `- ${splitSentences(p)[0]?.text ?? p.slice(0, 120)}`);
      return points.join('\n') || '- (empty document)';
    }
  }
}

export function createMockProvider(defaults: { latencyMs: number; mode: string }): AIProvider {
  let flakyCounter = 0;

  const settings = (mock?: MockControl) => ({
    latencyMs: mock?.latencyMs ?? defaults.latencyMs,
    mode: mock?.mode ?? (defaults.mode as NonNullable<MockControl['mode']>),
  });

  async function prelude(mode: string, latencyMs: number, signal: AbortSignal) {
    if (mode === 'timeout') {
      // Hang until the route's timeout (or the client) aborts us.
      await new Promise<never>((_, reject) => {
        const onAbort = () => reject(signal.reason instanceof ProviderError ? signal.reason : new ProviderError('aborted', 'aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    await abortableSleep(latencyMs, signal).catch(() => {
      throw signal.reason instanceof ProviderError ? signal.reason : new ProviderError('aborted', 'aborted');
    });
    if (mode === 'error') throw new ProviderError('server', 'mock error mode', { status: 500 });
    if (mode === 'ratelimit') throw new ProviderError('rate_limited', 'mock rate limit', { status: 429, retryAfterMs: 2000 });
    if (mode === 'flaky' && flakyCounter++ % 2 === 0) throw new ProviderError('server', 'mock flaky failure', { status: 503 });
  }

  return {
    id: 'mock',

    async generateStructured(req: StructuredRequest) {
      const { latencyMs, mode } = settings(req.mock);
      await prelude(mode, latencyMs, req.signal);
      if (mode === 'malformed') return '{"issues": [{"original": "unterminated';
      if (mode === 'empty') throw new ProviderError('empty', 'mock empty response');
      const issues = mockCorrections(req.task.text);
      if (mode === 'noisy') {
        issues.push(
          { original: 'phrase that is not in the text', prefix: '', replacements: ['x'], category: 'grammar', severity: 'error', title: 'Bogus', explanation: 'Not found.', confidence: 0.99 },
          { original: req.task.text.slice(0, 4) || 'x', prefix: '', replacements: [req.task.text.slice(0, 4) || 'x'], category: 'spelling', severity: 'error', title: 'Identity', explanation: 'No change.', confidence: 0.99 },
          { original: req.task.text.slice(0, 12) || 'x', prefix: '', replacements: ['A completely different and much longer rewrite. It even has two sentences.'], category: 'spelling', severity: 'error', title: 'Oversized', explanation: 'Too big.', confidence: 0.99 },
        );
      }
      return JSON.stringify({ issues });
    },

    async *streamText(req: TextRequest) {
      const { latencyMs, mode } = settings(req.mock);
      await prelude(mode, latencyMs, req.signal);
      if (mode === 'empty') return;
      const output = mockWrite(req.task);
      const pieces = output.match(/\S+\s*|\s+/g) ?? [output];
      const step = Math.max(15, Math.round(latencyMs / 6));
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) await abortableSleep(step, req.signal);
        yield pieces[i]!;
      }
    },
  };
}
