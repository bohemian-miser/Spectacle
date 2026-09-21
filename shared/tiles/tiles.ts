/**
 * Tile structure and the substitution system.
 *
 * Verbatim port of `sketch.ts:73–233` (buildSpectreBase / buildHatTurtleBase /
 * buildHexBase / buildSupertiles) and of the *structure* of the old
 * `Shape` / `Meta` classes — all drawing has been dropped.
 */

import {
  IDENT,
  REFLECT_X,
  mul,
  radians,
  transPt,
  trot,
  ttrans,
  type Affine,
  type Pt,
} from './geom';
import {
  leafPts,
  quadIndices,
  type TileFamilyId,
  type TileTypeId,
} from './families';

export interface LeafNode {
  readonly kind: 'leaf';
  /** Leaf type; geometry comes from `leafPts(family, type)`. */
  readonly type: TileTypeId;
  /** The four key points (old `Shape.quad`). */
  readonly quad: readonly Pt[];
}

export interface TileChild {
  readonly node: TileNode;
  readonly xform: Affine;
  readonly pos: number;
}

export interface MetaNode {
  readonly kind: 'meta';
  readonly type: TileTypeId;
  readonly quad: readonly Pt[];
  readonly children: readonly TileChild[];
}

export type TileNode = LeafNode | MetaNode;

/** label -> geometry, mirroring the old `sys` maps. Children are SHARED. */
export type TileSystem = Readonly<Record<string, TileNode>>;

const SUB_LABELS: readonly TileTypeId[] = [
  'Delta',
  'Theta',
  'Lambda',
  'Xi',
  'Pi',
  'Sigma',
  'Phi',
  'Psi',
];

function leaf(type: TileTypeId, quad: readonly Pt[]): LeafNode {
  return { kind: 'leaf', type, quad };
}

function quadOf(family: TileFamilyId, pts: readonly Pt[]): readonly Pt[] {
  const [a, b, c, d] = quadIndices(family);
  return [pts[a], pts[b], pts[c], pts[d]];
}

/** Port of `buildSpectreBase` (sketch.ts:73). Curviness is a render option. */
export function buildSpectreBase(): TileSystem {
  const spectre = leafPts('spectre', 'Delta');
  const keys = quadOf('spectre', spectre);
  const ret: Record<string, TileNode> = {};
  for (const lab of SUB_LABELS) ret[lab] = leaf(lab, keys);
  ret['Gamma'] = {
    kind: 'meta',
    type: 'Gamma',
    quad: keys,
    children: [
      { node: leaf('Gamma1', keys), xform: IDENT, pos: 0 },
      {
        node: leaf('Gamma2', keys),
        xform: mul(ttrans(spectre[8].x, spectre[8].y), trot(Math.PI / 6)),
        pos: 1,
      },
    ],
  };
  return ret;
}

/** Port of `buildHatTurtleBase` (sketch.ts:110). */
export function buildHatTurtleBase(hatDominant: boolean): TileSystem {
  const family: TileFamilyId = hatDominant ? 'hat' : 'turtle';
  const hat = leafPts('hat', 'Delta'); // HAT_PTS
  const turtle = leafPts('turtle', 'Delta'); // TURTLE_PTS
  const hatKeys = quadOf(family, hat);
  const turtleKeys = quadOf(family, turtle);

  const ret: Record<string, TileNode> = {};
  if (hatDominant) {
    for (const lab of SUB_LABELS) ret[lab] = leaf(lab, hatKeys);
    ret['Gamma'] = {
      kind: 'meta',
      type: 'Gamma',
      quad: hatKeys,
      children: [
        { node: leaf('Gamma1', hatKeys), xform: IDENT, pos: 0 },
        { node: leaf('Gamma2', turtleKeys), xform: ttrans(hat[8].x, hat[8].y), pos: 1 },
      ],
    };
  } else {
    for (const lab of SUB_LABELS) ret[lab] = leaf(lab, turtleKeys);
    ret['Gamma'] = {
      kind: 'meta',
      type: 'Gamma',
      quad: turtleKeys,
      children: [
        { node: leaf('Gamma1', turtleKeys), xform: IDENT, pos: 0 },
        {
          node: leaf('Gamma2', hatKeys),
          xform: mul(ttrans(turtle[9].x, turtle[9].y), trot(Math.PI / 3)),
          pos: 1,
        },
      ],
    };
  }
  return ret;
}

/** Port of `buildHexBase` (sketch.ts:154). */
export function buildHexBase(): TileSystem {
  const hex = leafPts('hex', 'Delta');
  const keys = quadOf('hex', hex);
  const ret: Record<string, TileNode> = {};
  for (const lab of ['Gamma', ...SUB_LABELS] as TileTypeId[]) ret[lab] = leaf(lab, keys);
  return ret;
}

export function buildBase(family: TileFamilyId): TileSystem {
  switch (family) {
    case 'hex':
      return buildHexBase();
    case 'hat':
      return buildHatTurtleBase(true);
    case 'turtle':
      return buildHatTurtleBase(false);
    default:
      return buildSpectreBase();
  }
}

/**
 * The 7 placement rules `[angleDeg, fromQuadIdx, toQuadIdx]` that
 * `buildSupertiles` chains into the shared child transforms `Ts[1..7]`.
 * Exported (additively) for the exact-arithmetic twin in `exact.ts`, which
 * re-derives the same transforms over Z[zeta12] integers.
 */
export const T_RULES: readonly (readonly [number, number, number])[] = [
  [60, 3, 1],
  [0, 2, 0],
  [60, 3, 1],
  [60, 3, 1],
  [0, 2, 0],
  [60, 3, 1],
  [-120, 3, 3],
];

/**
 * Child types per parent type, by slot 0..7 (`'null'` = no child in that
 * slot — only Gamma's slot 2). Exported (additively) for the un-rooted
 * ancestor-chain engine in `unrooted.ts`, which grows the hierarchy upward
 * and needs "which parents can hold a child of type X at slot s".
 */
export const SUPER_RULES: Readonly<Record<string, readonly string[]>> = {
  Gamma: ['Pi', 'Delta', 'null', 'Theta', 'Sigma', 'Xi', 'Phi', 'Gamma'],
  Delta: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Theta: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Lambda: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Xi: ['Psi', 'Delta', 'Pi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Pi: ['Psi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
  Sigma: ['Xi', 'Delta', 'Xi', 'Phi', 'Sigma', 'Pi', 'Lambda', 'Gamma'],
  Phi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Pi', 'Phi', 'Gamma'],
  Psi: ['Psi', 'Delta', 'Psi', 'Phi', 'Sigma', 'Psi', 'Phi', 'Gamma'],
};

/**
 * Verbatim port of `buildSupertiles` (sketch.ts:168–233).
 *
 * Every child transform is pre-multiplied by the reflection R, so each
 * substitution level is a mirror image of the previous one — see
 * {@link levelMirror}.
 */
export function buildSupertiles(sys: TileSystem): TileSystem {
  const quad = sys['Delta'].quad;
  const R = REFLECT_X;

  const Ts: Affine[] = [IDENT];
  let totalAng = 0;
  let rot: Affine = IDENT;
  const tquad = [...quad];
  for (const [ang, from, to] of T_RULES) {
    totalAng += ang;
    if (ang !== 0) {
      rot = trot(radians(totalAng));
      for (let i = 0; i < 4; ++i) tquad[i] = transPt(rot, quad[i]);
    }
    const prev = transPt(Ts[Ts.length - 1], quad[from]);
    const ttt = ttrans(prev.x - tquad[to].x, prev.y - tquad[to].y);
    Ts.push(mul(ttt, rot));
  }

  for (let idx = 0; idx < Ts.length; ++idx) Ts[idx] = mul(R, Ts[idx]);

  const superQuad = [
    transPt(Ts[6], quad[2]),
    transPt(Ts[5], quad[1]),
    transPt(Ts[3], quad[2]),
    transPt(Ts[0], quad[1]),
  ];

  const ret: Record<string, TileNode> = {};
  for (const [lab, subs] of Object.entries(SUPER_RULES)) {
    const children: TileChild[] = [];
    for (let idx = 0; idx < 8; ++idx) {
      if (subs[idx] === 'null') continue;
      children.push({ node: sys[subs[idx]], xform: Ts[idx], pos: idx });
    }
    ret[lab] = { kind: 'meta', type: lab as TileTypeId, quad: superQuad, children };
  }
  return ret;
}

/** R^level — the compensating view transform that keeps chirality stable. */
export function levelMirror(level: number): Affine {
  return level % 2 === 0 ? IDENT : REFLECT_X;
}

const systemCache = new Map<string, TileSystem>();

/** `buildBase` followed by `level` rounds of `buildSupertiles`, memoized. */
export function buildSystem(family: TileFamilyId, level: number): TileSystem {
  const lv = Math.max(0, Math.floor(level));
  const key = `${family}:${lv}`;
  const hit = systemCache.get(key);
  if (hit) return hit;
  const sys = lv === 0 ? buildBase(family) : buildSupertiles(buildSystem(family, lv - 1));
  systemCache.set(key, sys);
  return sys;
}

/** Flattened leaf instance for rendering & analysis. */
export interface TileInstance {
  /** Leaf type (Gamma1/Gamma2 in non-hex families, never composite 'Gamma'). */
  readonly type: TileTypeId;
  /** World transform, composed down the tree. */
  readonly xform: Affine;
  /** Path of child `pos` values, e.g. '3.7.0'. */
  readonly id: string;
}

export function flatten(root: TileNode, base: Affine = IDENT): readonly TileInstance[] {
  const out: TileInstance[] = [];
  const walk = (node: TileNode, xform: Affine, id: string): void => {
    if (node.kind === 'leaf') {
      out.push({ type: node.type, xform, id });
      return;
    }
    for (const child of node.children) {
      walk(child.node, mul(xform, child.xform), id === '' ? String(child.pos) : `${id}.${child.pos}`);
    }
  };
  walk(root, base, '');
  return out;
}

/** Ports `Shape.count` / `Meta.count`. */
export function countTiles(root: TileNode): number {
  if (root.kind === 'leaf') return 1;
  let total = 0;
  for (const child of root.children) total += countTiles(child.node);
  return total;
}

/** World-space bounding box of a tile tree's leaf outlines. */
export function bounds(root: TileNode, family: TileFamilyId): { min: Pt; max: Pt } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const inst of flatten(root)) {
    for (const p of leafPts(family, inst.type)) {
      const w = transPt(inst.xform, p);
      if (w.x < minX) minX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.x > maxX) maxX = w.x;
      if (w.y > maxY) maxY = w.y;
    }
  }
  if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
