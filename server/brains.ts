/**
 * Hot-loaded bot brains: new bot code goes live without a deploy, so the
 * rooms (boards, players, scores) live on.
 *
 * CI builds `shared/game/brains/` into one ES module whenever a push to main
 * touches nothing else (`scripts/brains.ts`, `.github/workflows/brains.yml`)
 * and puts it next to a `manifest.json` under `BOTS_URL`. Each server polls
 * that manifest (`BOTS_POLL_MS`, a minute) and, when it names a build it
 * hasn't got, fetches it, checks its SHA-256, imports it and hands it to
 * every room (`Bots.setBrains`): bot players stay, brains change.
 *
 * A build is only ever loaded by a server made from the same `shared/`
 * source outside `brains/` (`sourceKey`), so the engine, protocol and types
 * it was compiled against are this server's. Anything else — a server
 * change — is a full deploy, and its build waits for that deploy's servers.
 * A build that keeps throwing (`failed`) is dropped for the one the server
 * shipped with, and not loaded again.
 *
 * What a build can do is what any code in this process can do, so it must
 * only ever come from somewhere CI alone can write: on Cloud Run a private
 * bucket (`gs://…`, read with the instance's own service account).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBrainSet, type BrainSet } from '../shared/game/bots';

/** Where the brains live, relative to the repo root. */
export const BRAINS_DIR = 'shared/game/brains';

/** What CI uploads beside a build. */
export interface BrainsManifest {
  /** `sourceKey` of the source it was built from: only a server with the same key loads it. */
  readonly key: string;
  /** `brainsHash` of the brains it holds (equal to the server's own: nothing to load). */
  readonly brains: string;
  /** The build's file, beside the manifest. */
  readonly file: string;
  /** SHA-256 (hex) of that file. */
  readonly sha256: string;
  /** The commit it was built from, and when — for /status and the log. */
  readonly commit?: string;
  readonly builtAt?: string;
}

/** Which brains a server is playing with. */
export interface BrainsVersion {
  readonly source: 'built-in' | 'hot';
  readonly brains: string;
  readonly commit?: string;
  readonly loadedAt: number;
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (/\.(ts|tsx|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

function hashFiles(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files.map((f) => relative(root, f).split(sep).join('/')).sort()) {
    h.update(f).update('\0').update(readFileSync(join(root, f))).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** Everything under `shared/` but the brains: what a build and the server must share. */
export function sourceKey(root: string): string {
  const brains = join(root, BRAINS_DIR) + sep;
  return hashFiles(root, filesUnder(join(root, 'shared')).filter((f) => !f.startsWith(brains)));
}

/** The brains themselves. */
export function brainsHash(root: string): string {
  return hashFiles(root, filesUnder(join(root, BRAINS_DIR)));
}

/** `gs://bucket/prefix` → a reader of objects under it (instance credentials on GCP); `http(s)://…` → plain GETs. */
export function objectReader(base: string): (name: string) => Promise<Buffer> {
  const gs = /^gs:\/\/([^/]+)\/?(.*)$/.exec(base);
  if (!gs) {
    const root = base.replace(/\/+$/, '');
    return async (name) => get(`${root}/${name}`, {});
  }
  const [, bucket, prefix] = gs;
  const dir = prefix.replace(/\/+$/, '');
  let token: { value: string; until: number } | null = null;
  let noMetadata = false;
  const auth = async (): Promise<Record<string, string>> => {
    if (noMetadata) return {};
    if (!token || Date.now() > token.until) {
      try {
        const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(2000),
        });
        if (!r.ok) throw new Error(`metadata server: ${r.status}`);
        const j = (await r.json()) as { access_token: string; expires_in: number };
        token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
      } catch {
        // Not on GCP: read the bucket anonymously (it must be public then).
        noMetadata = true;
        return {};
      }
    }
    return { Authorization: `Bearer ${token.value}` };
  };
  return async (name) => {
    const object = encodeURIComponent(dir ? `${dir}/${name}` : name);
    return get(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`, await auth());
  };
}

async function get(url: string, headers: Record<string, string>): Promise<Buffer> {
  const r = await fetch(url, { headers: { ...headers, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GET ${url.replace(/\?.*$/, '')}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Import a build's bytes as a module and check it exports a brain set. */
export async function importBrains(code: Buffer, sha256: string): Promise<BrainSet> {
  const dir = join(tmpdir(), 'spectacle-brains');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `brains-${sha256}.mjs`);
  writeFileSync(file, code);
  const mod = (await import(pathToFileURL(file).href)) as { brains?: unknown };
  if (!isBrainSet(mod.brains)) throw new Error('the build does not export a brain set as `brains`');
  return mod.brains;
}

export interface WatcherOptions {
  /** `BOTS_URL`: where the manifest and builds are. */
  readonly url: string;
  /** This server's `sourceKey`. */
  readonly key: string;
  /** This server's own `brainsHash`. */
  readonly builtin: string;
  readonly builtinSet: BrainSet;
  /** Hand the brains to every room. */
  readonly apply: (set: BrainSet, version: BrainsVersion) => void;
  readonly log: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** Exceptions from a hot build, within `failWindowMs`, before it is dropped. */
  readonly maxFailures?: number;
  readonly failWindowMs?: number;
  readonly read?: (name: string) => Promise<Buffer>;
}

/** Polls `BOTS_URL` and swaps brains in (and, if they misbehave, back out). */
export class BrainsWatcher {
  version: BrainsVersion;
  /** The last manifest that couldn't be used, and why (for /status). */
  refused: { brains: string; commit?: string; reason: string } | null = null;
  private readonly read: (name: string) => Promise<Buffer>;
  /** Builds never to load again (they threw too often, or wouldn't load). */
  private readonly bad = new Set<string>();
  private failures: number[] = [];
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WatcherOptions) {
    this.read = opts.read ?? objectReader(opts.url);
    this.version = { source: 'built-in', brains: opts.builtin, loadedAt: Date.now() };
  }

  start(pollMs: number): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Look once. Resolves to true if new brains went in. Never throws. */
  async check(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      let m: BrainsManifest;
      try {
        m = JSON.parse((await this.read('manifest.json')).toString('utf8')) as BrainsManifest;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (why !== this.readError) this.opts.log('warn', `brains: no manifest at ${this.opts.url} (${why})`);
        this.readError = why;
        return false;
      }
      this.readError = null;
      if (m.brains === this.version.brains || this.bad.has(m.sha256)) return false;
      if (m.key !== this.opts.key) {
        this.refuse(m, `built from other shared/ source (${m.key}, this server ${this.opts.key}) — waits for a deploy`);
        return false;
      }
      if (m.brains === this.opts.builtin) {
        // The build is the one this server shipped with (a hot build went back to it).
        this.swap(this.opts.builtinSet, { source: 'built-in', brains: m.brains, loadedAt: Date.now() });
        return true;
      }
      try {
        const code = await this.read(m.file);
        const sha = createHash('sha256').update(code).digest('hex');
        if (sha !== m.sha256) throw new Error(`checksum ${sha.slice(0, 12)} is not the manifest's ${m.sha256.slice(0, 12)}`);
        const set = await importBrains(code, sha);
        this.swap(set, { source: 'hot', brains: m.brains, commit: m.commit, loadedAt: Date.now() }, sha);
        return true;
      } catch (e) {
        this.bad.add(m.sha256);
        this.refuse(m, e instanceof Error ? e.message : String(e));
        return false;
      }
    } finally {
      this.busy = false;
    }
  }

  private sha: string | null = null;
  /** The last failure to read the manifest (logged once, not every poll). */
  private readError: string | null = null;

  private swap(set: BrainSet, version: BrainsVersion, sha: string | null = null): void {
    this.opts.apply(set, version);
    this.version = version;
    this.sha = sha;
    this.failures = [];
    this.refused = null;
    this.opts.log('info', `brains: now ${version.source} ${version.brains}${version.commit ? ` (${version.commit.slice(0, 7)})` : ''}, kinds ${set.kinds.join(', ')}`);
  }

  private refuse(m: BrainsManifest, reason: string): void {
    const first = this.refused?.brains !== m.brains || this.refused.reason !== reason;
    this.refused = { brains: m.brains, commit: m.commit, reason };
    if (first) this.opts.log('warn', `brains: not loading ${m.brains}${m.commit ? ` (${m.commit.slice(0, 7)})` : ''}: ${reason}`);
  }

  /** A hot brain threw. Too often, and the server goes back to its own. */
  failed(now: number): void {
    if (this.version.source !== 'hot') return;
    const windowMs = this.opts.failWindowMs ?? 60_000;
    this.failures = this.failures.filter((t) => now - t < windowMs);
    this.failures.push(now);
    if (this.failures.length < (this.opts.maxFailures ?? 20)) return;
    const was = this.version;
    const reason = `threw ${this.failures.length} times in ${windowMs / 1000} s`;
    if (this.sha) this.bad.add(this.sha);
    this.opts.log('error', `brains: ${was.brains} ${reason} — back to the built-in brains`);
    this.swap(this.opts.builtinSet, { source: 'built-in', brains: this.opts.builtin, loadedAt: now });
    this.refused = { brains: was.brains, commit: was.commit, reason };
  }
}
