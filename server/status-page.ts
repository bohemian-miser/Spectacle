/**
 * /status: a read-only look at the running server — rooms, who is in them,
 * memory, how long a loop pass takes, and the recent log (joins, drops,
 * errors). The page polls /status.json every few seconds. Nothing on it can
 * change the game, and nothing in it (no ids, no tokens) lets anyone act as
 * a player.
 */

import type { FieldSpec } from '../shared/game/field';
import type { GameMode } from '../shared/game/knobs';

export interface LogLine {
  readonly at: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
}

export interface StatusReport {
  readonly now: number;
  readonly startedAt: number;
  readonly instance: { readonly id: string; readonly revision: string | null };
  readonly field: FieldSpec & { readonly tiles: number };
  readonly memory: { readonly rssMb: number; readonly heapMb: number };
  readonly tick: { readonly everyMs: number; readonly avgMs: number; readonly maxMs: number };
  readonly sockets: number;
  readonly counters: { readonly joins: number; readonly resumes: number; readonly leaves: number; readonly dropped: number; readonly errors: number };
  readonly limits: { readonly roomSize: number; readonly maxRooms: number; readonly botsPerRoom: number; readonly bots: string };
  readonly rooms: readonly {
    readonly id: string;
    readonly mode: GameMode;
    readonly named: boolean;
    readonly emptySince: number | null;
    readonly steps: number;
    readonly players: readonly {
      readonly name: string;
      readonly bot: boolean;
      readonly connected: boolean;
      readonly score: number;
      readonly lines: number;
      readonly patterns: number;
    }[];
  }[];
  readonly recent: readonly LogLine[];
}

export const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spectacle status</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --line: #dfe3e8; --text: #1d2330; --muted: #5b6472;
    --good: #1f8a4c; --warn: #b7791f; --bad: #c0392b; --accent: #2f6fdb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14171c; --panel: #1c2027; --line: #2c323c; --text: #e6e9ee; --muted: #9aa2b1;
      --good: #4cc27f; --warn: #e0b04f; --bad: #ef6b5b; --accent: #6ea8fe; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 16px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
  .muted { color: var(--muted); }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--good); margin-right: 6px; }
  .dot.is-down { background: var(--bad); }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stat span { color: var(--muted); font-size: 12px; }
  .is-warn { color: var(--warn); } .is-bad { color: var(--bad); }
  .rooms { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .room { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; min-width: 0; }
  .room-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .room-head a { color: var(--accent); font-weight: 600; text-decoration: none; }
  .tag { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td { padding: 2px 4px; border-top: 1px solid var(--line); white-space: nowrap; }
  td:first-child { width: 100%; white-space: normal; overflow-wrap: anywhere; }
  td.num { text-align: right; }
  .off { opacity: .55; }
  ol.log { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; max-height: 420px; overflow: auto; }
  ol.log li { padding: 4px 12px; border-top: 1px solid var(--line); display: flex; gap: 10px; font-size: 13px; }
  ol.log li:first-child { border-top: 0; }
  ol.log time { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  ol.log .warn { color: var(--warn); } ol.log .error { color: var(--bad); }
  ol.log span { overflow-wrap: anywhere; min-width: 0; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Spectacle status</h1>
    <span id="state" class="muted"><span class="dot"></span>loading…</span>
  </header>
  <div class="stats" id="stats"></div>
  <h2>Rooms</h2>
  <div class="rooms" id="rooms"></div>
  <h2>Recent</h2>
  <ol class="log" id="log"></ol>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h < 48 ? h + ' h ' + (m % 60) + ' min' : Math.floor(h / 24) + ' d';
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const stat = (value, label, cls = '') => '<div class="stat"><b class="' + cls + '">' + esc(value) + '</b><span>' + esc(label) + '</span></div>';

  function render(r) {
    const humans = r.rooms.flatMap((room) => room.players.filter((p) => !p.bot));
    const online = humans.filter((p) => p.connected).length;
    const held = humans.length - online;
    $('state').innerHTML = '<span class="dot"></span>instance ' + esc(r.instance.id) + (r.instance.revision ? ' (' + esc(r.instance.revision) + ')' : '') + ' · up ' + esc(ago(r.now - r.startedAt)) + ' · ' + esc(r.field.family) + ' level ' + esc(r.field.level) + ' · ' + esc(r.field.tiles.toLocaleString()) + ' tiles · bots: ' + esc(r.limits.bots);
    const tickCls = r.tick.maxMs > r.tick.everyMs ? 'is-bad' : r.tick.maxMs > r.tick.everyMs / 2 ? 'is-warn' : '';
    const memCls = r.memory.rssMb > 900 ? 'is-bad' : r.memory.rssMb > 750 ? 'is-warn' : '';
    $('stats').innerHTML = [
      stat(online, 'playing now' + (held ? ' · ' + held + ' reconnecting' : '')),
      stat(r.rooms.length + ' / ' + r.limits.maxRooms, 'rooms'),
      stat(r.sockets, 'open sockets'),
      stat(r.memory.rssMb + ' MB', 'memory (heap ' + r.memory.heapMb + ' MB)', memCls),
      stat(r.tick.avgMs + ' / ' + r.tick.maxMs + ' ms', 'loop avg / worst, of ' + r.tick.everyMs, tickCls),
      stat(r.counters.joins, 'joins · ' + r.counters.resumes + ' resumes'),
      stat(r.counters.dropped, 'dropped (too far behind)', r.counters.dropped ? 'is-warn' : ''),
      stat(r.counters.errors, 'errors', r.counters.errors ? 'is-bad' : ''),
    ].join('');
    $('rooms').innerHTML = r.rooms.map((room) => {
      const people = room.players.filter((p) => !p.bot);
      const link = location.origin + '/?room=' + encodeURIComponent(room.id);
      const rows = room.players.map((p) =>
        '<tr class="' + (p.connected ? '' : 'off') + '"><td>' + esc(p.name) + (p.bot ? ' <span class="muted">bot</span>' : p.connected ? '' : ' <span class="muted">reconnecting</span>') +
        '</td><td class="num">' + esc(p.score) + '</td><td class="num muted">' + esc(p.lines) + ' lines</td></tr>').join('');
      return '<div class="room"><div class="room-head"><a href="' + esc(link) + '" title="Join this room">' + esc(room.id) + '</a>' +
        '<span><span class="tag">' + esc(room.mode) + '</span>' + (room.named ? ' <span class="tag">link</span>' : '') + '</span></div>' +
        '<div class="muted">' + people.length + ' / ' + r.limits.roomSize + ' people · ' + room.steps.toLocaleString() + ' steps on the board' +
        (room.emptySince ? ' · empty ' + esc(ago(r.now - room.emptySince)) : '') + '</div>' +
        '<table>' + rows + '</table></div>';
    }).join('') || '<p class="muted">No rooms.</p>';
    $('log').innerHTML = r.recent.map((l) =>
      '<li><time>' + esc(clock(l.at)) + '</time><span class="' + esc(l.level) + '">' + esc(l.text) + '</span></li>').join('') || '<li class="muted">Nothing yet.</li>';
  }

  async function poll() {
    try {
      const res = await fetch('/status.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      render(await res.json());
    } catch (e) {
      $('state').innerHTML = '<span class="dot is-down"></span>server not answering (' + esc(e.message || e) + ') — retrying';
    }
  }
  poll();
  setInterval(poll, 5000);
</script>
</body>
</html>
`;
