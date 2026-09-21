/**
 * Palettes and colors — ports `config.ts` colmaps, the `leadColors` table
 * (tiles.ts:202–214) and `utils.getRainbowColor`.
 */

export type ColorSchemeId = 'bright' | 'fig53' | 'mystics' | 'pride' | 'custom';

export type Rgb = readonly [number, number, number];

/** config.colmap_orig */
export const PALETTE_BRIGHT: Readonly<Record<string, Rgb>> = {
  Gamma: [255, 255, 255],
  Gamma1: [255, 255, 255],
  Gamma2: [255, 255, 255],
  Delta: [220, 220, 220],
  Theta: [255, 191, 191],
  Lambda: [255, 160, 122],
  Xi: [255, 242, 0],
  Pi: [135, 206, 250],
  Sigma: [245, 245, 220],
  Phi: [0, 255, 0],
  Psi: [0, 255, 255],
};

/** config.colmap53 — colors from Figure 5.3 of the paper. */
export const PALETTE_FIG53: Readonly<Record<string, Rgb>> = {
  Gamma: [203, 157, 126],
  Gamma1: [203, 157, 126],
  Gamma2: [203, 157, 126],
  Delta: [163, 150, 133],
  Theta: [208, 215, 150],
  Lambda: [184, 205, 178],
  Xi: [211, 177, 144],
  Pi: [218, 197, 161],
  Sigma: [191, 146, 126],
  Phi: [228, 213, 167],
  Psi: [224, 223, 156],
};

/** config.colmap_mystics */
export const PALETTE_MYSTICS: Readonly<Record<string, Rgb>> = {
  Gamma: [196, 201, 169],
  Gamma1: [196, 201, 169],
  Gamma2: [156, 160, 116],
  Delta: [247, 252, 248],
  Theta: [247, 252, 248],
  Lambda: [247, 252, 248],
  Xi: [247, 252, 248],
  Pi: [247, 252, 248],
  Sigma: [247, 252, 248],
  Phi: [247, 252, 248],
  Psi: [247, 252, 248],
};

/** config.colmap_pride */
export const PALETTE_PRIDE: Readonly<Record<string, Rgb>> = {
  Gamma: [255, 255, 255],
  Gamma1: [97, 57, 21],
  Gamma2: [0, 0, 0],
  Delta: [2, 129, 33],
  Theta: [0, 76, 255],
  Lambda: [118, 0, 136],
  Xi: [229, 0, 0],
  Pi: [255, 175, 199],
  Sigma: [115, 215, 238],
  Phi: [255, 141, 0],
  Psi: [255, 238, 0],
};

export const TILE_PALETTES: Record<Exclude<ColorSchemeId, 'custom'>, Readonly<Record<string, Rgb>>> = {
  bright: PALETTE_BRIGHT,
  fig53: PALETTE_FIG53,
  mystics: PALETTE_MYSTICS,
  pride: PALETTE_PRIDE,
};

export const COLOR_SCHEME_IDS: readonly ColorSchemeId[] = [
  'bright',
  'fig53',
  'mystics',
  'pride',
  'custom',
];

export function rgbToCss(c: Rgb): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function rgbToHex(c: Rgb): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The raw `leadColors` table, keyed by a label's leading character. */
export const EDGE_LEAD_COLORS: Readonly<Record<string, Rgb>> = {
  '-': [218, 143, 143],
  '0': [143, 187, 218],
  '1': [255, 191, 135],
  '2': [150, 208, 150],
  '3': [235, 147, 148],
  '4': [202, 179, 222],
  '5': [198, 171, 165],
  '6': [241, 187, 225],
  '7': [191, 191, 191],
  '8': [222, 222, 145],
  '9': [139, 223, 231],
};

/** One identity per edge class, site-wide (dots, labels, subset chips). */
export const EDGE_CLASS_COLORS: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    Array.from({ length: 10 }, (_, k) => [k, rgbToCss(EDGE_LEAD_COLORS[String(k)])]),
  ),
);

/** Color the old code used for any negatively-signed label ('-' lead char). */
export const NEGATIVE_EDGE_COLOR = rgbToCss(EDGE_LEAD_COLORS['-']);

/** Grey used for open paths when rainbow tails are off (analysis.ts:289). */
export const TAIL_COLOR = '#808080';

/** utils.getRainbowColor — perceptually flattened hue ramp over t in [0,1]. */
export function rainbow(t: number): string {
  const h = t * 300;
  const l = 50 + 15 * Math.cos((h - 240) * (Math.PI / 180));
  return `hsl(${h}, 100%, ${l}%)`;
}

/** Two irrationals: adjacent lengths land far apart under either. */
const GOLDEN = 0.6180339887498949;
const ROOT2 = 1.4142135623730951;

/**
 * Colour for the `step`-th distinct circuit length in a patch — the ranked
 * palette the rooted analyses use, where what matters is telling THIS patch's
 * classes apart rather than comparing two patches.
 *
 * The golden angle rather than the 40° of `analysis.ts:257`: 40° repeats every
 * ninth rank, and one patch in ten has more than nine distinct lengths, so the
 * palette handed the same colour to two different circuit classes in the same
 * picture. 137.5° never lands on a rank it has used before, and spreads
 * whatever number of ranks there happen to be as evenly as any fixed step can.
 *
 * Lightness carries a second low-discrepancy cycle, so even ranks that end up
 * near each other on the wheel differ in tone.
 */
export function circuitHueColor(step: number): string {
  const i = Math.max(0, Math.floor(step));
  const h = (i * 137.50776405003785) % 360;
  const l = 46 + 14 * ((i * GOLDEN) % 1);
  return `hsl(${h.toFixed(1)}, 100%, ${l.toFixed(1)}%)`;
}

/**
 * Octaves of length the hue ramp spreads across: 1 tile at one end, 2^18 —
 * a quarter of a million — at the other.
 *
 * It was 12 (4096), and that was the bug: every circuit longer than 4096 got
 * the SAME hue, so a screen of long circuits came out uniformly pink. Over
 * lengths 1…20000 the old ramp spent 82% of its range in magenta, and lengths
 * 3995 and 16271 — four times apart — came out the same RGB exactly.
 *
 * 18 is chosen against the real distribution: the circuit lengths in
 * `lvl4.csv` and `lvl6.csv` run from 2 to 27,621, roughly flat per octave up
 * to 2^11 and thinning after. That fits inside the ramp with room to spare,
 * and the widest patch anyone can analyse would have to hold millions of tiles
 * to make a circuit that runs off the end of it.
 */
const LENGTH_HUE_SPAN = 18; // log2

/**
 * Solid ink for a circuit of `length` segments, addressed by the LENGTH itself
 * rather than a patch-relative rank — so a circuit of a given length is the
 * same colour in every view, on every screen, and across shared links.
 *
 * Three channels, each doing a different job:
 *
 *  - **hue ramps with log length**, warm for short and cooling through green,
 *    blue and violet as they grow. Monotonic, so two circuits of very
 *    different sizes are always far apart on the wheel — the comparison the
 *    colour exists to make. Log rather than linear because lengths spread over
 *    orders of magnitude; a linear ramp would give every short circuit the
 *    same red. Spread over {@link LENGTH_HUE_SPAN} octaves so it does not run
 *    out part-way up the real range, which is what turned every long circuit
 *    pink.
 *  - **lightness and saturation carry fast jitters** on two different
 *    irrationals. Neighbouring lengths share a hue — they are genuinely
 *    similar circuits — and these pull them apart. Two of them because two
 *    lengths then have to collide under BOTH to look alike: with lightness
 *    alone there were 8,511 exact RGB collisions over 1…30000, with both
 *    there are none.
 *
 * Measured over lengths 1…30000: the worst pair four times apart is 106 in
 * redmean distance (it was 2), the worst pair eight times apart is 157 (it was
 * 13), and every colour keeps a channel above 213 so it still reads as ink.
 * What is left is the pigeonhole limit — lengths within about 2% of each other
 * at the top of the range can share a colour, which is the honest failure to
 * have, since nothing distinguishes 20,000 from 20,137 on screen either.
 */
export function circuitLengthRgb(length: number): Rgb {
  const n = Math.max(1, Math.abs(Math.round(length)));
  const t = Math.min(1, Math.log2(n) / LENGTH_HUE_SPAN);
  // Almost a full turn: red-orange, yellow, green, cyan, blue, violet, magenta.
  // Stops short of wrapping so the longest never comes back round to the
  // shortest.
  const h = 0.02 + 0.94 * t;
  // Two fast low-discrepancy jitters, on different irrationals, so two lengths
  // have to miss on BOTH to look alike. With one (lightness alone) there were
  // 8,511 exact RGB collisions over 1…30000; with both there are none.
  const l = 0.46 + 0.22 * ((n * GOLDEN) % 1);
  const s = 0.8 + 0.2 * ((n * ROOT2) % 1);
  // hsl → rgb.
  const a = s * Math.min(l, 1 - l);
  const f = (ch: number): number => {
    const k = (ch + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
