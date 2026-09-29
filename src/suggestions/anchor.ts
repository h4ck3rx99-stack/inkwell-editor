import type { Node as PMNode } from '@tiptap/pm/model';
import { hashText, makeId } from '@/lib/hash';
import { countOccurrences } from '@/lib/text';
import type { Finding, Source, Suggestion } from './model';

export const BLOCK_ID_ATTR = 'bid';

/** One character per leaf so text offsets map 1:1 onto document positions. */
export function leafText(node: PMNode): string {
  return node.type.name === 'hardBreak' ? '\n' : '￼';
}

export function textOfBlock(node: PMNode): string {
  return node.textBetween(0, node.content.size, undefined, leafText);
}

export function textBetween(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', leafText);
}

export interface BlockRef {
  node: PMNode;
  /** Position before the block node; its text starts at pos + 1. */
  pos: number;
  id: string;
}

export function isAnalyzableBlock(node: PMNode): boolean {
  return node.isTextblock && node.type.name !== 'codeBlock' && typeof node.attrs[BLOCK_ID_ATTR] === 'string';
}

export function findBlock(doc: PMNode, blockId: string): BlockRef | null {
  let found: BlockRef | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock) {
      if (node.attrs[BLOCK_ID_ATTR] === blockId) found = { node, pos, id: blockId };
      return false;
    }
    return true;
  });
  return found;
}

export function blockAt(doc: PMNode, pos: number): BlockRef | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.isTextblock) {
      const id = node.attrs[BLOCK_ID_ATTR];
      return typeof id === 'string' ? { node, pos: $pos.before(d), id } : null;
    }
  }
  return null;
}

export function allBlocks(doc: PMNode): BlockRef[] {
  const out: BlockRef[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (isAnalyzableBlock(node)) out.push({ node, pos, id: node.attrs[BLOCK_ID_ATTR] as string });
      return false;
    }
    return true;
  });
  return out;
}

export function currentBlockHash(doc: PMNode, blockId: string): string | null {
  const b = findBlock(doc, blockId);
  return b ? hashText(textOfBlock(b.node)) : null;
}

/**
 * Anchor analyzer findings (text offsets) to live document positions.
 * Returns null when the block is gone or its text no longer matches `blockHash`:
 * a stale response must never produce suggestions.
 */
export function anchorFindings(
  doc: PMNode,
  blockId: string,
  blockHash: string,
  findings: readonly Finding[],
  meta: { source: Source; revision: number },
): Suggestion[] | null {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  const text = textOfBlock(block.node);
  if (hashText(text) !== blockHash) return null;
  const base = block.pos + 1;
  const out: Suggestion[] = [];
  for (const f of findings) {
    if (f.end <= f.start || f.end > text.length) continue;
    if (text.slice(f.start, f.end) !== f.original) continue;
    out.push({
      id: makeId('s'),
      blockId,
      from: base + f.start,
      to: base + f.end,
      original: f.original,
      replacements: f.replacements,
      category: f.category,
      severity: f.severity,
      source: meta.source,
      ruleId: f.ruleId,
      title: f.title,
      explanation: f.explanation,
      confidence: f.confidence,
      blockHash,
      revision: meta.revision,
      status: 'open',
    });
  }
  return out;
}

/**
 * The verification invariant: the document must contain exactly `original` at
 * [from, to). If not, relocate within the same block only when `original`
 * occurs exactly once there; otherwise the suggestion is unverifiable.
 */
export function verifySuggestion(doc: PMNode, s: Pick<Suggestion, 'from' | 'to' | 'original' | 'blockId'>): { from: number; to: number } | null {
  if (s.from >= 0 && s.to <= doc.content.size && s.from < s.to) {
    try {
      if (textBetween(doc, s.from, s.to) === s.original) return { from: s.from, to: s.to };
    } catch {
      // positions no longer valid; fall through to relocation
    }
  }
  const block = findBlock(doc, s.blockId);
  if (!block) return null;
  const text = textOfBlock(block.node);
  const hits = countOccurrences(text, s.original);
  if (hits.length !== 1) return null;
  const from = block.pos + 1 + hits[0]!;
  return { from, to: from + s.original.length };
}
