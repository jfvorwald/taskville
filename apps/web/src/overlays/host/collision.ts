export interface AnchoredBox {
  id: string;
  /** Projected anchor point, layer px. The box sits centred above it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Higher wins the contested spot. Ties break by id so the layout never flickers. */
  priority: number;
  /** False when the anchor is off screen or behind the camera: hidden, and takes no space. */
  visible: boolean;
}

export interface PlacedBox {
  id: string;
  left: number;
  top: number;
  visible: boolean;
}

export interface LayoutOptions {
  /** Minimum space kept between boxes, px. Default 0. */
  gap?: number;
}

/**
 * Places boxes above their anchors. Boxes are placed best first; one that would overlap a
 * placed box is lifted until it clears, and hidden if that pushes it out of the bounds. Pure and
 * order-independent. Results come back in input order.
 */
export function layoutAnchored(
  boxes: readonly AnchoredBox[],
  bounds: { width: number; height: number },
  options: LayoutOptions = {},
): PlacedBox[] {
  const gap = options.gap ?? 0;
  const results = new Map<string, PlacedBox>();
  const placed: { left: number; top: number; width: number; height: number }[] = [];

  const order = boxes
    .filter((b) => b.visible)
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const box of order) {
    const left = clamp(box.x - box.width / 2, 0, Math.max(0, bounds.width - box.width));
    let top = box.y - box.height;
    const fits = box.width <= bounds.width && box.height <= bounds.height;
    if (fits) {
      let blocker = findOverlap(placed, left, top, box, gap);
      while (blocker) {
        top = blocker.top - box.height - gap;
        blocker = findOverlap(placed, left, top, box, gap);
      }
    }
    const inside = fits && top >= 0 && top + box.height <= bounds.height;
    results.set(box.id, { id: box.id, left, top, visible: inside });
    if (inside) placed.push({ left, top, width: box.width, height: box.height });
  }

  return boxes.map(
    (b) =>
      results.get(b.id) ?? {
        id: b.id,
        left: b.x - b.width / 2,
        top: b.y - b.height,
        visible: false,
      },
  );
}

function findOverlap(
  placed: readonly { left: number; top: number; width: number; height: number }[],
  left: number,
  top: number,
  box: { width: number; height: number },
  gap: number,
) {
  return placed.find(
    (p) =>
      left < p.left + p.width + gap &&
      p.left < left + box.width + gap &&
      top < p.top + p.height + gap &&
      p.top < top + box.height + gap,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
