export interface Placement {
  top: number;
  left: number;
  above: boolean;
}

/** Place a floating box of `size` next to `anchor`, preferring below, flipping above, clamped to the viewport. */
export function placeNear(anchor: DOMRect, size: { width: number; height: number }, opts: { gap?: number; prefer?: 'below' | 'above' } = {}): Placement {
  const gap = opts.gap ?? 8;
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const margin = 12;
  const spaceBelow = vh - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const preferAbove = opts.prefer === 'above';
  let above = preferAbove ? spaceAbove >= size.height || spaceAbove > spaceBelow : spaceBelow < size.height && spaceAbove > spaceBelow;
  if (preferAbove && spaceAbove < size.height && spaceBelow >= size.height) above = false;
  const top = above ? Math.max(margin, anchor.top - gap - size.height) : Math.min(vh - margin - size.height, anchor.bottom + gap);
  const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, vw - margin - size.width));
  return { top, left, above };
}
