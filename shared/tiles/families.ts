/**
 * Family/tile tables — verbatim data port of `web/src/tiles.ts` (vertex arrays
 * and edge-label tables) plus `web/src/config.ts` (`tile_names`).
 *
 * The old code selected tables from the global `state.shape`; here the family
 * is always an explicit argument.
 */

import type { Pt } from './geom';

export type TileFamilyId = 'spectre' | 'spectre-iso' | 'hex' | 'hat' | 'turtle';

export type TileTypeId =
  | 'Gamma'
  | 'Delta'
  | 'Theta'
  | 'Lambda'
  | 'Xi'
  | 'Pi'
  | 'Sigma'
  | 'Phi'
  | 'Psi'
  | 'Gamma1'
  | 'Gamma2';

export const FAMILIES: readonly TileFamilyId[] = ['spectre', 'spectre-iso', 'hex', 'hat', 'turtle'];

/** Display names used by the old shape dropdown (sketch.ts). */
export const FAMILY_DISPLAY_NAMES: Readonly<Record<TileFamilyId, string>> = {
  spectre: 'Tile(1,1)',
  'spectre-iso': 'Tile(1,1), hex-isomorphic labels',
  hex: 'Hexagons',
  hat: 'Turtles in Hats',
  turtle: 'Hats in Turtles',
};

export function familyFromDisplayName(name: string): TileFamilyId | null {
  for (const f of FAMILIES) {
    if (FAMILY_DISPLAY_NAMES[f] === name) return f;
  }
  return null;
}

/** config.tile_names — the 9 substitution labels (Gamma is composite). */
export const TILE_NAMES: readonly TileTypeId[] = [
  'Gamma',
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Phi',
  'Psi',
];

/**
 * Canonical leaf order for matching-index vectors and CSV combo strings.
 * MUST stay exactly this order (matches the notebook's ALL_TILE_NAMES).
 */
export const LEAF_ORDER: readonly TileTypeId[] = [
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Phi',
  'Psi',
  'Gamma2',
  'Gamma1',
];

/** The hexagon family has a single `Gamma` leaf instead of Gamma1/Gamma2. */
export const HEX_LEAF_ORDER: readonly TileTypeId[] = [
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Phi',
  'Psi',
  'Gamma',
];

export function leafOrder(family: TileFamilyId): readonly TileTypeId[] {
  return family === 'hex' ? HEX_LEAF_ORDER : LEAF_ORDER;
}

/** tiles.spectre_pts */
export const SPECTRE_PTS: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 1.0, y: 0.0 },
  { x: 1.5, y: -0.8660254037844386 },
  { x: 2.366025403784439, y: -0.36602540378443865 },
  { x: 2.366025403784439, y: 0.6339745962155614 },
  { x: 3.366025403784439, y: 0.6339745962155614 },
  { x: 3.866025403784439, y: 1.5 },
  { x: 3.0, y: 2.0 },
  { x: 2.133974596215561, y: 1.5 },
  { x: 1.6339745962155614, y: 2.3660254037844393 },
  { x: 0.6339745962155614, y: 2.3660254037844393 },
  { x: -0.3660254037844386, y: 2.3660254037844393 },
  { x: -0.866025403784439, y: 1.5 },
  { x: 0.0, y: 1.0 },
];

/** tiles.hex_pts */
export const HEX_PTS: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 1.0, y: 0.0 },
  { x: 1.5, y: 0.8660254037844386 },
  { x: 1, y: 2 * 0.8660254037844386 },
  { x: 0, y: 2 * 0.8660254037844386 },
  { x: -0.5, y: 0.8660254037844386 },
];

/** tiles.hat_pts */
export const HAT_PTS: readonly Pt[] = [
  { x: 0, y: -1.7320508075688772 },
  { x: 1, y: -1.7320508075688772 },
  { x: 1.5, y: -2.598076211353316 },
  { x: 3, y: -1.7320508075688772 },
  { x: 3, y: 0 },
  { x: 4, y: 0 },
  { x: 4.5, y: 0.8660254037844386 },
  { x: 3, y: 1.7320508075688772 },
  { x: 1.5, y: 0.8660254037844386 },
  { x: 1, y: 1.7320508075688772 },
  { x: 0, y: 1.7320508075688772 },
  { x: -1, y: 1.7320508075688772 },
  { x: -1.5, y: 0.8660254037844386 },
  { x: 0, y: 0 },
];

/** tiles.turtle_pts */
export const TURTLE_PTS: readonly Pt[] = [
  { x: 0, y: 0 },
  { x: 1.5, y: 0.8660254037844386 },
  { x: 3, y: 0 },
  { x: 3.5, y: 0.8660254037844386 },
  { x: 3, y: 1.7320508075688772 },
  { x: 4.5, y: 2.598076211353316 },
  { x: 4.5, y: 4.330127018922193 },
  { x: 3.5, y: 4.330127018922193 },
  { x: 3, y: 3.4641016151377544 },
  { x: 1.5, y: 4.330127018922193 },
  { x: 0, y: 3.4641016151377544 },
  { x: -1.5, y: 2.598076211353316 },
  { x: -1.5, y: 0.8660254037844386 },
  { x: -0.5, y: 0.8660254037844386 },
];

/** tiles.unique_edge_labels — 14 physical edges per tile. */
export const SPECTRE_EDGE_LABELS: Readonly<Record<string, readonly string[]>> = {
  Delta: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-3.1A', '-3.0A', '-6.1A', '-6.0A'],
  Theta: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '8.0A', '2.0B', '2.1B', '2.2B', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Lambda: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-8.0A', '-2.2A', '-2.1A', '-2.0A'],
  Xi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '8.0A', '2.0A', '2.1A', '2.2A', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Pi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-8.0A', '-2.2A', '-2.1A', '-2.0A'],
  Sigma: ['4.2A', '4.3A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-3.1A', '-3.0A', '4.0A', '4.1A'],
  Phi: ['3.0A', '3.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '5.0A', '5.1A', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Psi: ['-1.2A', '-1.1A', '-1.0A', '5.0A', '5.1A', '-5.1A', '-5.0A', '5.0B', '5.1B', '0.0A', '0.1A', '-2.2A', '-2.1A', '-2.0A'],
  Gamma2: ['-7.1A', '-7.0A', '-3.1A', '-3.0A', '6.0A', '6.1A', '-4.3A', '-4.2A', '-4.1A', '-4.0A', '2.0A', '2.1A', '-7.3A', '-7.2A'],
  Gamma1: ['-1.2A', '-1.1A', '-1.0A', '1.0A', '1.1A', '1.2A', '7.0A', '7.1A', '7.2A', '7.3A', '2.2A', '-2.2A', '-2.1A', '-2.0A'],
};

/**
 * Tile(1,1) labelled so its seams match the hexagon family's one for one.
 *
 * {@link SPECTRE_EDGE_LABELS} gives the Sigma a single four-edge class-4 seam
 * and the Mystic a class-6 seam, so class 6 joins Delta to Gamma and class 4
 * never shows up in a valid rule. In the hexagons Sigma has a class-6 edge
 * and a class-4 edge, and class 6 joins Delta to Sigma. The two tilings really
 * do differ there: a thin wedge of Gamma2 (its edges 4–7) sits between the
 * Delta's `-6` seam and the Sigma's first two edges, where the hexagons have
 * Delta and Sigma touching.
 *
 * This table splits that four-edge seam in two. The Sigma's edges 0–1
 * (`4.2A`, `4.3A`) become a `6` seam, glued to Gamma2's edges 6–7, which
 * become `-6`; the other half stays class 4 (`4.0A`, `4.1A` / `-4.1A`,
 * `-4.0A`). Everything else is {@link SPECTRE_EDGE_LABELS} unchanged.
 *
 * Gamma2 then carries a `6` and a `-6` dot side by side, with no other dot
 * between them: pairing those two is the chord that stands in for the
 * hexagons' Delta–Sigma edge, and every other tile has exactly the hexagon
 * tile's dots in the hexagon tile's order. Class parities (and so the valid
 * rules) match the hexagons', with class 7 riding along inside the Mystic as
 * before (`128` ↔ `1278`).
 */
export const SPECTRE_ISO_EDGE_LABELS: Readonly<Record<string, readonly string[]>> = {
  ...SPECTRE_EDGE_LABELS,
  Sigma: ['6.0A', '6.1A', '2.0A', '2.1A', '2.2A', '-5.1A', '-5.0A', '1.0A', '1.1A', '1.2A', '-3.1A', '-3.0A', '4.0A', '4.1A'],
  Gamma2: ['-7.1A', '-7.0A', '-3.1A', '-3.0A', '6.0A', '6.1A', '-6.1A', '-6.0A', '-4.1A', '-4.0A', '2.0A', '2.1A', '-7.3A', '-7.2A'],
};

/** tiles.hex_edge_labels — 6 physical edges per tile. */
export const HEX_EDGE_LABELS: Readonly<Record<string, readonly string[]>> = {
  Delta: ['3.0A', '2.0A', '-5.0A', '1.0A', '-3.0A', '-6.0A'],
  Theta: ['3.0A', '2.0A', '8.0A', '2.0B', '0.0A', '-2.0A'],
  Lambda: ['3.0A', '2.0A', '-5.0A', '1.0A', '-8.0A', '-2.0A'],
  Xi: ['-1.0A', '5.0A', '8.0A', '2.0A', '0.0A', '-2.0A'],
  Pi: ['-1.0A', '5.0A', '-5.0A', '1.0A', '-8.0A', '-2.0A'],
  Sigma: ['6.0A', '2.0A', '-5.0A', '1.0A', '-3.0A', '4.0A'],
  Phi: ['3.0A', '2.0A', '-5.0A', '5.0A', '0.0A', '-2.0A'],
  Psi: ['-1.0A', '5.0A', '-5.0A', '5.0B', '0.0A', '-2.0A'],
  Gamma: ['-1.0A', '1.0A', '-3.0A', '-4.0A', '2.0A', '-2.0A'],
};

/**
 * Vertex array for a leaf tile of a family. Encapsulates the dominance logic
 * of the old `getEdgeDotMidpoints` (tiles.ts:119–131):
 *   hat family    → Gamma2 is a Turtle, everything else a Hat
 *   turtle family → Gamma2 is a Hat, everything else a Turtle
 */
export function leafPts(family: TileFamilyId, type: TileTypeId): readonly Pt[] {
  switch (family) {
    case 'hex':
      return HEX_PTS;
    case 'hat':
      return type === 'Gamma2' ? TURTLE_PTS : HAT_PTS;
    case 'turtle':
      return type === 'Gamma2' ? HAT_PTS : TURTLE_PTS;
    default:
      return SPECTRE_PTS;
  }
}

/** Edge labels for a tile in a family (empty array for unknown tiles). */
export function edgeLabels(family: TileFamilyId, type: TileTypeId): readonly string[] {
  const table =
    family === 'hex'
      ? HEX_EDGE_LABELS
      : family === 'spectre-iso'
        ? SPECTRE_ISO_EDGE_LABELS
        : SPECTRE_EDGE_LABELS;
  return table[type] ?? [];
}

/** The four "key points" that form a tile's quad, per family. */
export function quadIndices(family: TileFamilyId): readonly [number, number, number, number] {
  return family === 'hex' ? [1, 2, 3, 5] : [3, 5, 7, 11];
}

export function isLeafType(family: TileFamilyId, type: TileTypeId): boolean {
  return leafOrder(family).includes(type);
}
