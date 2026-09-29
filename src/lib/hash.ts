/**
 * cyrb53: a fast, well-distributed 53-bit non-cryptographic string hash.
 * Used for block-text identity (staleness checks, caches, dismissal keys).
 * Never used for anything security-relevant.
 */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
}

let counter = 0;
/** Short, unique-enough id for suggestions and blocks (not persisted across devices). */
export function makeId(prefix = ''): string {
  counter = (counter + 1) % 1679616;
  const rand = Math.floor(Math.random() * 2176782336).toString(36).padStart(6, '0');
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${rand}`;
}
