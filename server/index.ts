/**
 * Spectacle game server: rooms of each game mode (normal, conquest), one
 * WebSocket endpoint (`/ws`), and the built client served as static files
 * from `dist/`. A room fills to ROOM_SIZE humans; the next joiner of that mode
 * gets a new room, and extra rooms close again once they sit empty.
 *
 * Environment:
 *   PORT          (8787)     HTTP + WebSocket port
 *   FIELD_FAMILY  (hex)      hex | spectre
 *   FIELD_LEVEL   (6)        substitution level (hex: 5 ≈ 31k tiles, 6 ≈ 242k)
 *   FIELD_ROOT    (Delta)    root tile type
 *   BOTS          (1)        bot players per room
 *   ROOM_SIZE     (10)       humans per room before another opens
 *   MAX_ROOMS     (24)       rooms at most (then joiners share the emptiest)
 *   ROOM_IDLE_MS  (60000)    an extra empty room closes after this long
 *   SEED          (random)   RNG seed
 *   RESUME_GRACE_MS (300000) how long a dropped player is kept for `join.resume`
 *   KNOB_*                   any knob, e.g. KNOB_BASE_STEP_MS=250 (see shared/game/knobs.ts)
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine } from '../shared/game/engine';
import { buildField, DEFAULT_FIELD_SPEC, fieldOutline, type FieldSpec } from '../shared/game/field';
import { GAME_MODES, isGameMode, knobsForMode, knobsFromEnv, type GameMode, type Knobs } from '../shared/game/knobs';
import type { ClientMessage, GameEvent, RoomSummary, ServerMessage } from '../shared/game/protocol';
import { PLAYABLE_FAMILIES, validateRule } from '../shared/game/rule';
import { mulberry32 } from '../shared/game/rng';
import { cleanRoomName } from '../shared/game/room-name';
import type { TileFamilyId, TileTypeId } from '../shared/tiles';
import { Bots } from '../shared/game/bots';
import { STATUS_PAGE, type LogLine, type StatusReport } from './status-page';

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

// --- log ----------------------------------------------------------------------

/** The last few hundred things worth knowing, for /status. */
const recent: LogLine[] = [];
const RECENT_MAX = 300;
const counters = { joins: 0, resumes: 0, leaves: 0, dropped: 0, errors: 0 };

/** Log to stdout (Cloud Run keeps it) and to the /status page's list. */
function note(level: LogLine['level'], text: string, detail?: string): void {
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[spectacle] ${text}`, ...(detail ? [detail] : []));
  recent.push({ at: Date.now(), level, text });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

const startedAt = Date.now();
const baseKnobs = knobsFromEnv(process.env);
const spec = fieldSpecFromEnv();
const t0 = Date.now();
// One field for every room: it is deterministic from the spec and never
// mutated, so a new room costs an engine's worth of state, not a field.
const field = buildField(spec);
// The outline is only needed when a line runs edge to edge; build it now, not mid-tick.
fieldOutline(field);
note('info', `field ${spec.family} level ${spec.level} root ${spec.rootTile}: ${field.count} tiles in ${Date.now() - t0} ms`);

const seed = process.env.SEED ? Number(process.env.SEED) : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
const seedRng = mulberry32(seed);
const BOTS = Number(process.env.BOTS ?? 1);
/** Humans per room before the next joiner is put in a new one. */
const ROOM_SIZE = Math.max(1, Number(process.env.ROOM_SIZE ?? 10));
/** Rooms at most, all modes together; past it, joiners squeeze into the emptiest room of their mode. */
const MAX_ROOMS = Math.max(GAME_MODES.length, Number(process.env.MAX_ROOMS ?? 24));
/** An extra room nobody is in (or holding for) is closed after this long. */
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS ?? 60_000);
/**
 * A socket this far behind on sends is dropped (it can resume) rather than
 * buffered forever. Its welcome doesn't count: that snapshot is one message,
 * and on a busy board it alone can be bigger than this.
 */
const MAX_BUFFERED = Number(process.env.MAX_BUFFERED_MB ?? 4) * 1024 * 1024;
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
  if (url.pathname === '/status.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(statusReport()));
    return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(STATUS_PAGE);
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: humansOnline(), tiles: field.count, spec, rooms: [...rooms.values()].map((r) => r.summary()) }));
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
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });

// --- rooms -------------------------------------------------------------------

interface Client {
  readonly ws: WebSocket;
  id: string;
  joined: boolean;
  lastTapAt: number;
  room: Room | null;
  /** Bytes of the last welcome, which may still be draining: not "behind". */
  allowance: number;
  /** The player's name once joined, for the log. */
  name: string;
}

/**
 * Run `fn`, logging instead of throwing: one bad message or one room's broken
 * tick must not take the process — and every room with it — down.
 */
const lastLogged = new Map<string, number>();
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    const now = Date.now();
    // A tick that throws once tends to throw every 50 ms: log it every 10 s.
    if (now - (lastLogged.get(what) ?? 0) < 10_000) return;
    lastLogged.set(what, now);
    counters.errors++;
    note('error', `error in ${what}: ${e instanceof Error ? e.message : String(e)}`, e instanceof Error ? e.stack : undefined);
  }
}

/**
 * One arena: an engine, its bots, and the clients watching it. Rooms of a
 * mode fill up to `ROOM_SIZE` humans; the next joiner opens another. Player
 * ids are unique across rooms, so a resume ticket finds its room by itself.
 */
class Room {
  readonly engine: Engine;
  readonly bots: Bots;
  readonly clients = new Map<string, Client>();
  pending: GameEvent[] = [];
  /** When the room last had nobody in it (0 while occupied). */
  emptySince = 0;

  constructor(
    readonly id: string,
    readonly mode: GameMode,
    /** Opened by a `?room=` link: only links lead in, never matchmaking. */
    readonly named = false,
  ) {
    const rng = mulberry32((seedRng.next() * 0xffffffff) >>> 0);
    this.engine = new Engine(field, knobsForMode(baseKnobs, mode), rng);
    this.bots = new Bots(this.engine, rng);
    this.pending.push(...this.bots.add(BOTS, Date.now()));
  }

  get knobs(): Knobs {
    return this.engine.knobs;
  }

  /** Humans in the room, counting the ones held for a resume. */
  humans(): number {
    let n = 0;
    for (const p of this.engine.players.values()) if (!p.bot) n++;
    return n;
  }

  summary(): RoomSummary {
    return { id: this.id, mode: this.mode, players: this.humans(), capacity: ROOM_SIZE };
  }

  tick(now: number, dt: number): void {
    // Nobody watching: the board holds still (bots included) and costs nothing.
    if (this.clients.size === 0) {
      if (this.emptySince === 0) this.emptySince = now;
      if (this.pending.length === 0) return;
    } else this.emptySince = 0;
    const ev = this.clients.size > 0 ? this.engine.tick(dt) : [];
    if (this.clients.size > 0) this.bots.update(now, ev);
    if (this.pending.length) {
      ev.unshift(...this.pending);
      this.pending = [];
    }
    if (ev.length === 0) return;
    const payload = JSON.stringify({ t: 'events', ev } satisfies ServerMessage);
    for (const c of this.clients.values()) {
      if (!c.joined || c.ws.readyState !== c.ws.OPEN) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED + c.allowance) {
        counters.dropped++;
        note('warn', `${c.name || c.id} in ${this.id} too far behind (${c.ws.bufferedAmount} bytes buffered), dropped`);
        c.ws.close(4001, 'too far behind');
        continue;
      }
      c.ws.send(payload);
    }
  }
}

const rooms = new Map<string, Room>();
const roomCount: Record<GameMode, number> = { normal: 0, conquest: 0 };
/** Player id → the room holding them (connected or held for a resume). */
const playerRoom = new Map<string, Room>();

function openRoom(mode: GameMode, name?: string): Room {
  let id = name;
  // A link may already have taken the next number's name.
  while (!id || rooms.has(id)) id = `${mode}-${++roomCount[mode]}`;
  const room = new Room(id, mode, name !== undefined);
  rooms.set(room.id, room);
  note('info', `opened room ${room.id}${room.named ? ' (from a link)' : ''} · ${rooms.size} rooms`);
  return room;
}

/** The room a new player of `mode` goes into: the fullest with space, else a new one, else the emptiest. */
function roomFor(mode: GameMode): Room {
  let best: Room | null = null;
  let emptiest: Room | null = null;
  for (const r of rooms.values()) {
    if (r.mode !== mode || r.named) continue;
    const n = r.humans();
    if (n < ROOM_SIZE && (!best || n > best.humans())) best = r;
    if (n < r.knobs.maxPlayers && (!emptiest || n < emptiest.humans())) emptiest = r;
  }
  if (best) return best;
  if (rooms.size < MAX_ROOMS || !emptiest) return openRoom(mode);
  return emptiest;
}

/**
 * The room a joiner goes into. A link names one: that room if it exists,
 * whatever its mode, else a new room by that name (while there is space for
 * one). Otherwise matchmaking by mode.
 */
function roomForJoin(mode: GameMode, link: unknown): Room {
  const name = cleanRoomName(link);
  if (!name) return roomFor(mode);
  const room = rooms.get(name);
  if (room) return room;
  return rooms.size < MAX_ROOMS ? openRoom(mode, name) : roomFor(mode);
}

/** Close extra rooms that have sat empty — no one connected, no one held for a resume. */
function reapRooms(now: number): void {
  for (const r of rooms.values()) {
    if (r.clients.size > 0 || r.humans() > 0 || r.emptySince === 0 || now - r.emptySince < ROOM_IDLE_MS) continue;
    const others = [...rooms.values()].filter((q) => q.mode === r.mode && q !== r && !q.named);
    if (!r.named && others.length === 0) continue; // keep one matchmade room of each mode warm
    rooms.delete(r.id);
    note('info', `closed idle room ${r.id} · ${rooms.size} rooms`);
  }
}

function humansOnline(): number {
  let n = 0;
  for (const r of rooms.values()) n += r.humans();
  return n;
}

for (const mode of GAME_MODES) openRoom(mode);

// --- connections -------------------------------------------------------------

let nextClient = 1;

/**
 * Dropped players are kept for a grace period so a reconnect (a flaky phone, a
 * page refresh, or Cloud Run's hourly request cap) picks the same player up:
 * same id, room, score, lines. The token is issued in `welcome` and must come
 * back in `join.resume`.
 *
 * - 128 random bits from the CSPRNG; only its SHA-256 is kept here, compared
 *   in constant time.
 * - Single use: every successful resume issues a new token and the old one
 *   dies, so a copied or leaked ticket stops working once the owner is back.
 * - A resume may take over a player whose old socket is still open — a
 *   refresh often reconnects before the server has seen the old page go. The
 *   token proves ownership; the old socket is detached and closed.
 */
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS ?? 300_000);
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
  const room = playerRoom.get(id);
  if (!room || !room.engine.players.has(id)) return;
  detached.set(
    id,
    setTimeout(() => {
      detached.delete(id);
      tokenHashes.delete(id);
      playerRoom.delete(id);
      note('info', `${room.engine.players.get(id)?.name ?? id} timed out of ${room.id}`);
      room.pending.push(...room.engine.removePlayer(id));
    }, RESUME_GRACE_MS),
  );
}

function tryResume(client: Client, resume: unknown): Room | null {
  if (!resume || typeof resume !== 'object') return null;
  const r = resume as { id?: unknown; token?: unknown };
  if (typeof r.id !== 'string' || typeof r.token !== 'string' || r.token.length > 128) return null;
  const want = tokenHashes.get(r.id);
  const room = playerRoom.get(r.id);
  if (!want || !room || !room.engine.players.has(r.id) || !timingSafeEqual(want, hashToken(r.token))) return null;
  const expiry = detached.get(r.id);
  if (expiry !== undefined) {
    clearTimeout(expiry);
    detached.delete(r.id);
  }
  // Still attached elsewhere (the page before a refresh): cut that socket
  // loose first, so its close handler neither removes nor detaches us.
  const old = room.clients.get(r.id);
  if (old && old !== client) {
    old.joined = false;
    room.clients.delete(r.id);
    old.room = null;
    old.id = `gone${nextClient++}`;
    old.ws.close(4000, 'resumed elsewhere');
  }
  client.id = r.id;
  return room;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _\-.'!?]/gu, '')
    .trim()
    .slice(0, baseKnobs.maxNameLength);
  return s || 'anon';
}

function welcome(client: Client, room: Room): void {
  const snap = room.engine.snapshot();
  const payload = JSON.stringify({
    t: 'welcome',
    you: client.id,
    token: issueToken(client.id),
    field: spec,
    knobs: room.knobs,
    players: snap.players,
    paths: snap.paths,
    room: room.id,
  } satisfies ServerMessage);
  client.allowance = payload.length;
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
}

wss.on('connection', (ws) => {
  const client: Client = { ws, id: `p${nextClient++}`, joined: false, lastTapAt: 0, room: null, allowance: 0, name: '' };
  send(ws, {
    t: 'hello',
    field: spec,
    knobs: knobsForMode(baseKnobs, 'normal'),
    tiles: field.count,
    players: humansOnline(),
    rooms: [...rooms.values()].map((r) => r.summary()),
  });

  ws.on('message', (data) => guard('message', () => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      send(ws, { t: 'error', message: 'bad json' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const room = client.room;
    switch (msg.t) {
      case 'join': {
        if (client.joined) return;
        const resumed = tryResume(client, msg.resume);
        if (resumed) {
          client.name = resumed.engine.players.get(client.id)?.name ?? '';
          counters.resumes++;
          note('info', `${client.name} resumed in ${resumed.id}`);
          client.joined = true;
          client.room = resumed;
          resumed.clients.set(client.id, client);
          welcome(client, resumed);
          return;
        }
        const rule = validateRule(msg.rule, field.family);
        if (!rule) {
          send(ws, { t: 'error', message: 'invalid rule for this arena' });
          return;
        }
        const target = roomForJoin(isGameMode(msg.mode) ? msg.mode : 'normal', msg.room);
        if (target.engine.players.size >= target.knobs.maxPlayers) {
          send(ws, { t: 'error', message: 'arena full' });
          return;
        }
        const ev = target.engine.addPlayer(client.id, cleanName(msg.name), rule);
        client.name = target.engine.players.get(client.id)?.name ?? '';
        counters.joins++;
        note('info', `${client.name} joined ${target.id}`);
        client.joined = true;
        client.room = target;
        target.clients.set(client.id, client);
        playerRoom.set(client.id, target);
        welcome(client, target);
        // Everyone else learns about the newcomer now; the newcomer already
        // has themselves in the snapshot.
        const payload = JSON.stringify({ t: 'events', ev } satisfies ServerMessage);
        for (const c of target.clients.values()) if (c !== client && c.joined && c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
        return;
      }
      case 'tap': {
        if (!client.joined || !room) return;
        const now = Date.now();
        if (now - client.lastTapAt < 100) return;
        client.lastTapAt = now;
        const x = Number(msg.x);
        const y = Number(msg.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const { result, events } = room.engine.tap(client.id, Number(msg.tile), { x, y });
        if (!result.ok) send(ws, { t: 'events', ev: [{ t: 'refused', reason: result.reason }] });
        room.pending.push(...events);
        return;
      }
      case 'rule': {
        if (!client.joined || !room) return;
        const rule = validateRule(msg.rule, field.family);
        if (!rule) {
          send(ws, { t: 'events', ev: [{ t: 'refused', reason: 'invalid rule' }] });
          return;
        }
        room.pending.push(...room.engine.setRule(client.id, rule));
        return;
      }
      case 'swap': {
        if (!client.joined || !room) return;
        const rule = validateRule(msg.rule, field.family);
        const r = rule ? room.engine.swapPattern(client.id, Number(msg.index), rule) : { ok: false as const, reason: 'invalid rule' };
        if (!r.ok) send(ws, { t: 'events', ev: [{ t: 'refused', reason: r.reason }] });
        else room.pending.push(...r.events);
        return;
      }
      case 'pattern': {
        if (!client.joined || !room) return;
        room.pending.push(...room.engine.setActive(client.id, Number(msg.index)));
        return;
      }
      case 'leave': {
        if (!client.joined || !room) return;
        // Gone for good: no resume, and the seat is free straight away.
        counters.leaves++;
        note('info', `${client.name} left ${room.id}`);
        client.joined = false;
        client.room = null;
        room.clients.delete(client.id);
        tokenHashes.delete(client.id);
        playerRoom.delete(client.id);
        room.pending.push(...room.engine.removePlayer(client.id));
        client.id = `p${nextClient++}`;
        return;
      }
      case 'ping':
        send(ws, { t: 'pong', n: msg.n });
        return;
      default:
        return;
    }
  }));

  ws.on('close', (code) => guard('close', () => {
    const room = client.room;
    if (!room) return;
    if (client.joined) note('info', `${client.name} disconnected from ${room.id} (code ${code})`);
    if (room.clients.get(client.id) === client) room.clients.delete(client.id);
    if (client.joined) detach(client.id);
  }));
  ws.on('error', () => ws.close());
});

// --- simulation loop -----------------------------------------------------------

/** How long a loop pass takes: over `tickMs` and the game falls behind. */
const tickStats = { avgMs: 0, maxMs: 0, maxSince: Date.now() };

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(1000, now - last);
  last = now;
  const t = performance.now();
  for (const room of rooms.values()) guard(`tick ${room.id}`, () => room.tick(now, dt));
  guard('reap', () => reapRooms(now));
  const took = performance.now() - t;
  tickStats.avgMs = tickStats.avgMs * 0.98 + took * 0.02;
  // The worst pass in the last minute or so.
  if (now - tickStats.maxSince > 60_000) {
    tickStats.maxMs = 0;
    tickStats.maxSince = now;
  }
  tickStats.maxMs = Math.max(tickStats.maxMs, took);
}, baseKnobs.tickMs);

// --- status --------------------------------------------------------------------

/** Everything /status shows. Read-only, and nothing in it lets anyone act as a player. */
function statusReport(): StatusReport {
  const mem = process.memoryUsage();
  return {
    now: Date.now(),
    startedAt,
    field: { ...spec, tiles: field.count },
    memory: { rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6) },
    tick: { everyMs: baseKnobs.tickMs, avgMs: +tickStats.avgMs.toFixed(2), maxMs: +tickStats.maxMs.toFixed(1) },
    sockets: wss.clients.size,
    counters,
    limits: { roomSize: ROOM_SIZE, maxRooms: MAX_ROOMS, botsPerRoom: BOTS },
    rooms: [...rooms.values()].map((r) => {
      const players = [...r.engine.players.values()].map((p) => ({
        name: p.name,
        bot: p.bot,
        connected: p.bot || r.clients.has(p.id),
        score: p.score,
        lines: p.paths.length,
        patterns: p.patterns.length,
      }));
      players.sort((a, b) => b.score - a.score);
      let steps = 0;
      for (const p of r.engine.players.values()) for (const path of p.paths) steps += path.steps.length;
      return { id: r.id, mode: r.mode, named: r.named, emptySince: r.emptySince || null, steps, players };
    }),
    recent: recent.slice(-150).reverse(),
  };
}

http.listen(PORT, () => {
  note('info', `listening on http://localhost:${PORT}  (ws: /ws, seed ${seed}, bots ${BOTS} per room, ${ROOM_SIZE} per room, max ${MAX_ROOMS} rooms)`);
});
