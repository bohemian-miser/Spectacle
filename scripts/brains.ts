/**
 * Build and check the hot-loaded bot brains (see server/brains.ts).
 *
 *   npm run brains -- build [dir]   bundle shared/game/brains/ into dir
 *                                   (default dist-brains/): brains-<sha>.mjs
 *                                   and manifest.json, ready to upload
 *   npm run brains -- check [dir]   load that build the way a server does and
 *                                   play it: a bots-only game, then a live
 *                                   swap from the built-in brains onto it
 *                                   mid-game. Exits 1 if anything throws.
 *
 * CI runs both on every PR, and uploads on a push to main (.github/workflows/brains.yml).
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Bots, BUILTIN_BRAINS, formatBotMix, type BotMix, type BrainSet } from '../shared/game/bots';
import { Engine } from '../shared/game/engine';
import { buildField, fieldOutline } from '../shared/game/field';
import { DEFAULT_KNOBS, GAME_MODES, knobsForMode } from '../shared/game/knobs';
import { mulberry32 } from '../shared/game/rng';
import { BRAINS_DIR, brainsHash, importBrains, sourceKey, type BrainsManifest } from '../server/brains';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Bundle the brains: one self-contained ES module (its own copy of what it
 * uses from shared/). `variant` (tests) builds `source` instead of
 * `index.ts`, as if it sat in the brains directory, labelled `label`.
 */
export async function buildBrains(outDir: string, variant?: { source: string; label: string }): Promise<BrainsManifest> {
  const out = await build({
    ...(variant
      ? { stdin: { contents: variant.source, resolveDir: join(ROOT, BRAINS_DIR), loader: 'ts' as const, sourcefile: 'variant.ts' } }
      : { entryPoints: [join(ROOT, BRAINS_DIR, 'index.ts')] }),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'warning',
  });
  const code = out.outputFiles[0].contents;
  const sha256 = createHash('sha256').update(code).digest('hex');
  const manifest: BrainsManifest = {
    key: sourceKey(ROOT),
    brains: variant?.label ?? brainsHash(ROOT),
    file: `brains-${sha256.slice(0, 16)}.mjs`,
    sha256,
    commit: process.env.GITHUB_SHA ?? gitHead(),
    builtAt: new Date().toISOString(),
  };
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, manifest.file), code);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function gitHead(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

/** Load a build as a server would (manifest, checksum, source key, shape). */
export async function loadBuilt(dir: string): Promise<{ manifest: BrainsManifest; set: BrainSet }> {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BrainsManifest;
  const code = readFileSync(join(dir, manifest.file));
  const sha = createHash('sha256').update(code).digest('hex');
  if (sha !== manifest.sha256) throw new Error(`checksum ${sha} is not the manifest's ${manifest.sha256}`);
  if (manifest.key !== sourceKey(ROOT)) throw new Error(`built from other shared/ source (${manifest.key}, here ${sourceKey(ROOT)})`);
  return { manifest, set: await importBrains(code, sha) };
}

/** Play the build: alone, and swapped in under bots already on the board. Throws on any failure. */
export function trial(set: BrainSet, log: (s: string) => void = () => {}): void {
  for (const mode of GAME_MODES) {
    const mix = set.mix?.[mode];
    if (!mix) continue;
    const unknown = Object.keys(mix).filter((k) => !set.kinds.includes(k));
    if (unknown.length) throw new Error(`mix for ${mode} names kinds the brains don't have: ${unknown.join(', ')}`);
  }
  const field = buildField({ family: 'hex', level: 4, rootTile: 'Delta' });
  fieldOutline(field);
  const everyKind = (kinds: readonly string[]): BotMix => Object.fromEntries(kinds.map((k) => [k, 1]));

  const play = (engine: Engine, bots: Bots, from: number, ms: number): number => {
    const dt = engine.knobs.tickMs;
    let now = from;
    for (; now < from + ms; now += dt) bots.update(now, engine.tick(dt));
    return now;
  };

  // 1. On its own, every kind, both modes.
  for (const mode of GAME_MODES) {
    const rng = mulberry32(7);
    const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, mode), rng);
    const bots = new Bots(engine, rng, undefined, {}, set);
    bots.add(everyKind(set.kinds), 0);
    play(engine, bots, 0, 2 * 60_000);
    const lines = [...engine.players.values()].reduce((n, p) => n + p.paths.length, 0);
    if (lines === 0) throw new Error(`${mode}: two minutes of ${formatBotMix(bots.mix(), set.kinds)} drew no lines`);
    log(`${mode}: ${formatBotMix(bots.mix(), set.kinds)} played 2 min, ${lines} lines`);
  }

  // 2. A live swap: built-in bots play a while, then get the new brains.
  const rng = mulberry32(11);
  const engine = new Engine(field, knobsForMode(DEFAULT_KNOBS, 'normal'), rng);
  const bots = new Bots(engine, rng);
  bots.add(everyKind(BUILTIN_BRAINS.kinds), 0);
  let now = play(engine, bots, 0, 60_000);
  const before = bots.list();
  const lines = (id: string) => engine.players.get(id)?.paths.map((q) => q.id).join(',');
  const linesBefore = new Map(before.map((b) => [b.id, lines(b.id)]));
  bots.setBrains(set, now);
  for (const b of before) {
    if (!set.kinds.includes(b.kind)) continue;
    if (!engine.players.has(b.id)) throw new Error(`the swap dropped ${b.kind} ${b.id}, a kind the new brains have`);
    if (lines(b.id) !== linesBefore.get(b.id)) throw new Error(`the swap changed ${b.kind} ${b.id}'s lines`);
  }
  bots.reconcile(set.mix?.normal ?? everyKind(set.kinds), now);
  now = play(engine, bots, now, 2 * 60_000);
  log(`swap: ${before.length} built-in bots → ${formatBotMix(bots.mix(), set.kinds)}, played 2 more min`);
}

async function main(): Promise<void> {
  const [cmd, dirArg] = process.argv.slice(2);
  const dir = resolve(dirArg ?? join(ROOT, 'dist-brains'));
  if (cmd === 'build') {
    const m = await buildBrains(dir);
    console.log(`built ${m.file} (brains ${m.brains}, source key ${m.key}) in ${dir}`);
  } else if (cmd === 'check') {
    const { manifest, set } = await loadBuilt(dir);
    console.log(`loaded ${manifest.file}: kinds ${set.kinds.join(', ')}`);
    trial(set, (s) => console.log(`  ${s}`));
    console.log('ok');
  } else {
    console.error('usage: npm run brains -- build|check [dir]');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
