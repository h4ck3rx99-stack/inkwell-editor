import { hashText } from '@/lib/hash';
import { sentenceAt } from '@/lib/text';
import { ruleKeyOf, type Suggestion } from './model';

/**
 * Dismissal keys. The primary key is (block hash + original + rule), as the
 * product spec requires, so re-analysis of identical text never resurfaces a
 * dismissed issue. A secondary sentence-scoped key keeps the dismissal alive
 * when the user edits a *different* sentence of the same paragraph.
 */
export function dismissKeys(
  s: Pick<Suggestion, 'blockHash' | 'original' | 'ruleId' | 'category' | 'source'>,
  blockText: string | null,
  offsetInBlock: number | null,
): string[] {
  const rule = ruleKeyOf(s);
  const keys = [`b:${s.blockHash}|${s.original}|${rule}`];
  if (blockText !== null && offsetInBlock !== null) {
    const sentence = sentenceAt(blockText, offsetInBlock);
    if (sentence) keys.push(`s:${hashText(sentence.text)}|${s.original}|${rule}`);
  }
  return keys;
}

export function isDismissed(
  dismissed: ReadonlySet<string>,
  s: Pick<Suggestion, 'blockHash' | 'original' | 'ruleId' | 'category' | 'source'>,
  blockText: string,
  offsetInBlock: number,
): boolean {
  if (dismissed.size === 0) return false;
  return dismissKeys(s, blockText, offsetInBlock).some((k) => dismissed.has(k));
}
