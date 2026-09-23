/**
 * Spectacle game server: one arena, one WebSocket endpoint (`/ws`), and the
 * built client served as static files from `dist/`.
 *
 * Environment:
 *   PORT          (8787)     HTTP + WebSocket port
 *   FIELD_FAMILY  (hex)      hex | spectre
 *   FIELD_LEVEL   (6)        substitution level (hex: 5 ≈ 31k tiles, 6 ≈ 242k)
 *   FIELD_ROOT    (Delta)    root tile type
 *   BOTS          (1)        number of bot players
 *   SEED          (random)   RNG seed
 *   RESUME_GRACE_MS (90000)  how long a dropped player is kept for `join.resume`
 *   KNOB_*                   any knob, e.g. KNOB_BASE_STEP_MS=250 (see shared/game/knobs.ts)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine } from '../shared/game/engine';
import { buildField, DEFAULT_FIELD_SPEC, type FieldSpec } from '../shared/game/field';
import { knobsFromEnv } from '../shared/game/knobs';
import type { ClientMessage, GameEvent, ServerMessage } from '../shared/game/protocol';
import { PLAYABLE_FAMILIES, validateRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import type { TileFamilyId, TileTypeId } from '../shared/tiles';
import { Bots } from '../shared/game/bots';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');

function fieldSpecFromEnv(): FieldSpec {
  const family = (process.env.FIELD_FAMILY ?? DEFAULT_FIELD_SPEC.family) as TileFamilyId;
  if (!PLAYABLE_FAMILIES.includes(family)) throw new Error(`FIELD_FAMILY must be one of ${PLAYABLE_FAMILIES.join(', ')}`);
  const level = Number(process.env.FIELD_LEVEL ?? DEFAULT_FIELD_SPEC.level);
  if (!Number.isInteger(level) || level < 1 || level > 7) throw new Error('FIELD_LEVEL must be 1..7');
  const rootTile = (process.env.FIELD_ROOT ?? DEFAULT_FIELD_SPEC.rootTile) as TileTypeId;
  return { family, level, rootTile };
}

const knobs = knobsFromEnv(process.env);
const spec = fieldSpecFromEnv();
const t0 = Date.now();
const field = buildField(spec);
console.log(`[spectacle] field ${spec.family} level ${spec.level} root ${spec.rootTile}: ${field.count} tiles in ${Date.now() - t0} ms`);

const seed = process.env.SEED ? Number(process.env.SEED) : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
const rng = mulberry32(seed);
const engine = new Engine(field, knobs, rng);
const bots = new Bots(engine, rng);

// --- static files ------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: engine.players.size, tiles: field.count, spec }));
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Client not built. Run `npm run build`, or use `npm run dev` for the Vite dev server.');
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, 'index.html');
    path = '/index.html';
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': path === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws' });

// --- connections -------------------------------------------------------------

interface Client {
  readonly ws: WebSocket;
  id: string;
  joined: boolean;
  lastTapAt: number;
}

const clients = new Map<string, Client>();
let nextClient = 1;
let pending: GameEvent[] = [];

/**
 * Dropped players are kept for a grace period so a reconnect (a flaky phone, a
 * page refresh, or Cloud Run's hourly request cap) picks the same player up:
 * same id, score, lines. The token is issued in `welcome` and must come back in
 * `join.resume`.
 *
 * - 128 random bits from the CSPRNG; only its SHA-256 is kept here, compared
 *   in constant time.
 * - Single use: every successful resume issues a new token and the old one
 *   dies, so a copied or leaked ticket stops working once the owner is back.
 * - A resume may take over a player whose old socket is still open — a
 *   refresh often reconnects before the server has seen the old page go. The
 *   token proves ownership; the old socket is detached and closed.
 */
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS ?? 90_000);
const tokenHashes = new Map<string, Buffer>(); // player id → sha256(token)
const detached = new Map<string, ReturnType<typeof setTimeout>>(); // player id → expiry

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** A new resume token for `id`, replacing any earlier one. */
function issueToken(id: string): string {
  const token = randomBytes(16).toString('hex');
  tokenHashes.set(id, hashToken(token));
  return token;
}

function detach(id: string): void {
  if (!engine.players.has(id)) return;
  detached.set(
    id,
    setTimeout(() => {
      detached.delete(id);
      tokenHashes.delete(id);
      pending.push(...engine.removePlayer(id));
    }, RESUME_GRACE_MS),
  );
}

function tryResume(client: Client, resume: unknown): boolean {
  if (!resume || typeof resume !== 'object') return false;
  const r = resume as { id?: unknown; token?: unknown };
  if (typeof r.id !== 'string' || typeof r.token !== 'string' || r.token.length > 128) return false;
  const want = tokenHashes.get(r.id);
  if (!want || !engine.players.has(r.id) || !timingSafeEqual(want, hashToken(r.token))) return false;
  const expiry = detached.get(r.id);
  if (expiry !== undefined) {
    clearTimeout(expiry);
    detached.delete(r.id);
  }
  // Still attached elsewhere (the page before a refresh): cut that socket
  // loose first, so its close handler neither removes nor detaches us.
  const old = clients.get(r.id);
  if (old && old !== client) {
    old.joined = false;
    old.id = `gone${nextClient++}`;
    old.ws.close(4000, 'resumed elsewhere');
  }
  clients.delete(client.id);
  client.id = r.id;
  clients.set(client.id, client);
  return true;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _\-.'!?]/gu, '')
    .trim()
    .slice(0, knobs.maxNameLength);
  return s || 'anon';
}

wss.on('connection', (ws) => {
  const client: Client = { ws, id: `p${nextClient++}`, joined: false, lastTapAt: 0 };
  clients.set(client.id, client);
  send(ws, { t: 'hello', field: spec, knobs, tiles: field.count, players: engine.players.size });

  ws.on('message', (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      send(ws, { t: 'error', message: 'bad json' });
      return;
    }
    switch (msg.t) {
      case 'join': {
        if (client.joined) return;
        if (tryResume(client, msg.resume)) {
          client.joined = true;
          const snap = engine.snapshot();
          send(ws, { t: 'welcome', you: client.id, token: issueToken(client.id), field: spec, knobs, players: snap.players, paths: snap.paths });
          return;
        }
        const rule = validateRule(msg.rule, field.family);
        if (!rule) {
          send(ws, { t: 'error', message: 'invalid rule for this arena' });
          return;
        }
        if (engine.players.size >= knobs.maxPlayers) {
          send(ws, { t: 'error', message: 'arena full' });
          return;
        }
        const ev = engine.addPlayer(client.id, cleanName(msg.name), rule);
        client.joined = true;
        const token = issueToken(client.id);
        const snap = engine.snapshot();
        send(ws, { t: 'welcome', you: client.id, token, field: spec, knobs, players: snap.players, paths: snap.paths });
        // Everyone else learns about the newcomer on the next flush; the
        // newcomer already has themselves in the snapshot.
        for (const c of clients.values()) if (c !== client && c.joined) send(c.ws, { t: 'events', ev });
        return;
      }
      case 'tap': {
        if (!client.joined) return;
        const now = Date.now();
        if (now - client.lastTapAt < 100) return;
        client.lastTapAt = now;
        const x = Number(msg.x);
        const y = Number(msg.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const { result, events } = engine.tap(client.id, Number(msg.tile), { x, y });
        if (!result.ok) send(ws, { t: 'events', ev: [{ t: 'refused', reason: result.reason }] });
        pending.push(...events);
        return;
      }
      case 'rule': {
        if (!client.joined) return;
        const rule = validateRule(msg.rule, field.family);
        if (!rule) {
          send(ws, { t: 'events', ev: [{ t: 'refused', reason: 'invalid rule' }] });
          return;
        }
        pending.push(...engine.setRule(client.id, rule));
        return;
      }
      case 'ping':
        send(ws, { t: 'pong', n: msg.n });
        return;
      default:
        return;
    }
  });

  ws.on('close', () => {
    clients.delete(client.id);
    if (client.joined) detach(client.id);
  });
  ws.on('error', () => ws.close());
});

// --- simulation loop -----------------------------------------------------------

pending.push(...bots.add(Number(process.env.BOTS ?? 1), Date.now()));

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(1000, now - last);
  last = now;
  const ev = engine.tick(dt);
  bots.update(now, ev);
  if (pending.length) {
    ev.unshift(...pending);
    pending = [];
  }
  if (ev.length === 0) return;
  const payload = JSON.stringify({ t: 'events', ev } satisfies ServerMessage);
  for (const c of clients.values()) {
    if (c.joined && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  }
}, knobs.tickMs);

http.listen(PORT, () => {
  console.log(`[spectacle] listening on http://localhost:${PORT}  (ws: /ws, seed ${seed}, bots ${process.env.BOTS ?? 1})`);
});
