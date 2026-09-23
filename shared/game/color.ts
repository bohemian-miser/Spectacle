/**
 * Colour mixing for the wire. Player colours travel as `hsl(h, s%, l%)`; a
 * captured pattern's colour is a blend of its new owner's and its source's,
 * mixed in RGB and handed back as `hsl(…)` so everything that reads hues off
 * player colours (the circuit ramp, the light board's deepening) still works.
 */

type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [((h * 60) % 360 + 360) % 360, s, l];
}

function parseHsl(css: string): Rgb | null {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css);
  return m ? hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100) : null;
}

/** `a` and `b` mixed, `t` of the way from `a` to `b` (RGB), as `hsl(…)`. Unparseable → `a`. */
export function mixHsl(a: string, b: string, t: number): string {
  const x = parseHsl(a);
  const y = parseHsl(b);
  if (!x || !y) return a;
  const [h, s, l] = rgbToHsl([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
  return `hsl(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%)`;
}
