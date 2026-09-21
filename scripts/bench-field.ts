/** How long a field takes to build, and how big it is, per level. `npx tsx scripts/bench-field.ts` */
import { buildField } from '../shared/game/field';
import type { TileFamilyId } from '../shared/tiles';

for (const family of ['hex', 'spectre'] as TileFamilyId[]) {
  for (let level = 3; level <= 6; level++) {
    const t0 = performance.now();
    const f = buildField({ family, level, rootTile: 'Delta' });
    const ms = performance.now() - t0;
    const w = (f.bounds.maxX - f.bounds.minX).toFixed(0);
    const h = (f.bounds.maxY - f.bounds.minY).toFixed(0);
    console.log(`${family.padEnd(8)} level ${level}: ${String(f.count).padStart(7)} tiles, ${w}×${h} units, ${ms.toFixed(0)} ms`);
  }
}
