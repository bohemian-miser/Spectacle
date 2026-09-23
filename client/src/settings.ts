/**
 * Board display settings, per browser (localStorage): how circuits are
 * coloured, and whether the tiles wear their palette at all. The theme lives
 * in `theme.ts`; the settings modal edits all three.
 */

import { useEffect, useState } from 'react';

/**
 * Circuit colouring:
 *  a  owner ramp — hue ±110° round the owner's colour and lightness by length;
 *     each nesting level darkens the wash 14%.
 *  b  Spectre's length palette (`circuitLengthRgb`, as in the rule lab) for
 *     loops and washes alike; nesting darkens as in a.
 *  c  depth bands — loops on the owner ramp; the wash steps its hue 50° and
 *     its lightness down with every level of nesting.
 *  d  contour stripes — loops on the length palette; nesting levels alternate
 *     light and dark like a topographic map.
 *  e  depth heatmap — loops on the length palette; the wash is a magma scale
 *     by depth (yellow, orange, red, purple, near-black).
 */
export type CircuitStyle = 'a' | 'b' | 'c' | 'd' | 'e';

export const CIRCUIT_STYLES: readonly { readonly id: CircuitStyle; readonly label: string }[] = [
  { id: 'a', label: 'A · Owner ramp' },
  { id: 'b', label: 'B · Length palette' },
  { id: 'c', label: 'C · Depth bands' },
  { id: 'd', label: 'D · Contour stripes' },
  { id: 'e', label: 'E · Depth heatmap' },
];

export interface Settings {
  readonly circuitStyle: CircuitStyle;
  /** Hide the tile palette and arrows: a blank board with the arena's edge. */
  readonly plainTiles: boolean;
}

const KEY = 'spectacle.settings';

export function parseCircuitStyle(v: unknown): CircuitStyle | null {
  return v === 'a' || v === 'b' || v === 'c' || v === 'd' || v === 'e' ? v : null;
}

function load(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* private mode or junk */
  }
  const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('circuits');
  return {
    circuitStyle: parseCircuitStyle(param) ?? parseCircuitStyle(saved.circuitStyle) ?? 'a',
    plainTiles: saved.plainTiles === true,
  };
}

let current: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* this tab only */
  }
  for (const fn of listeners) fn();
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setLocal] = useState(getSettings);
  useEffect(() => {
    const fn = (): void => setLocal(getSettings());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return [s, updateSettings];
}
