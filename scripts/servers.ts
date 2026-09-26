/**
 * Which servers are up and who is on them — across every Cloud Run instance,
 * not just the one /status happens to reach.
 *
 * Instances share nothing, so the only view across them all is the log: each
 * instance with anyone connected writes a `heartbeat` line a minute (see
 * server/index.ts). This reads those, plus the service's revisions and
 * traffic, the instance-count metric (idle instances don't beat), which
 * instance /status.json reaches right now (not /healthz: Cloud Run's front end
 * reserves paths ending in z and answers them 404 itself), and the recent joins/leaves from the log.
 *
 *   npx tsx scripts/servers.ts                      # Cloud Run, via gcloud's login
 *   npx tsx scripts/servers.ts --watch 30           # redraw every 30 s
 *   npx tsx scripts/servers.ts --since 10m --events 40
 *   npx tsx scripts/servers.ts --json               # the raw picture, for jq
 *   npx tsx scripts/servers.ts --url http://localhost:8787   # one server's /status.json (local, the VM)
 *
 * Flags: --project (gcloud's default), --region us-central1, --service spectacle.
 * Needs `gcloud auth login` (the token comes from `gcloud auth print-access-token`)
 * and read access to Cloud Run, Logging and Monitoring on the project.
 */

import { execFileSync } from 'node:child_process';
import type { StatusReport } from '../server/status-page';

// --- args ---------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string): boolean => argv.includes(`--${name}`);
if (has('help') || has('h')) {
  console.log(usage());
  process.exit(0);
}

const REGION = flag('region') ?? 'us-central1';
const SERVICE = flag('service') ?? 'spectacle';
const SINCE_MS = duration(flag('since') ?? '5m');
const EVENTS = Number(flag('events') ?? 15);
const WATCH_S = flag('watch') !== undefined ? Math.max(5, Number(flag('watch')) || 30) : 0;
const JSON_OUT = has('json');
const DIRECT_URL = flag('url');

function duration(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration ${s} (e.g. 90s, 5m, 2h)`);
  return Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[(m[2] ?? 'm') as 's' | 'm' | 'h' | 'd'];
}

function usage(): string {
  return `servers.ts — see scripts/servers.ts's header for usage.
  --watch N   redraw every N s     --since 5m   heartbeat/event window
  --events N  recent joins/leaves  --json       raw output
  --url URL   one server's /status.json instead of Cloud Run
  --project P --region ${REGION} --service ${SERVICE}`;
}

// --- output -------------------------------------------------------------------

const tty = process.stdout.isTTY && !JSON_OUT;
const paint = (code: string) => (s: string | number): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}
const clock = (t: number | string): string => new Date(t).toLocaleTimeString([], { hour12: false });

// --- Google APIs (REST, one token from gcloud) --------------------------------

function gcloud(args: string[]): string {
  try {
    return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const err = (e as { stderr?: string }).stderr ?? String(e);
    if (/reauthentication|auth login|credentials/i.test(err)) {
      console.error(red('gcloud is not logged in.') + ' Run:  gcloud auth login');
    } else console.error(red(`gcloud ${args.join(' ')} failed:`) + '\n' + err);
    process.exit(2);
  }
}

const PROJECT = DIRECT_URL ? '' : flag('project') ?? gcloud(['config', 'get-value', 'project']);
let token = '';
let tokenAt = 0;
function accessToken(): string {
  // Tokens last an hour; take a fresh one well before that when watching.
  if (!token || Date.now() - tokenAt > 30 * 60e3) {
    token = gcloud(['auth', 'print-access-token']);
    tokenAt = Date.now();
  }
  return token;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${new URL(url).host}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** A value, or the reason it couldn't be had — one failing API shouldn't hide the rest. */
type Got<T> = { ok: true; value: T } | { ok: false; error: string };
async function got<T>(p: Promise<T>): Promise<Got<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- what the server writes (server/index.ts) ---------------------------------

interface Heartbeat {
  message: 'heartbeat';
  instance: { id: string; revision: string | null };
  startedAt: string;
  sockets: number;
  players: number;
  rooms: { id: string; mode: string; humans: string[] }[];
}

interface LogEntry {
  timestamp: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  labels?: { instanceId?: string };
  resource: { labels: { revision_name?: string } };
}

// --- gather -------------------------------------------------------------------

interface Picture {
  at: number;
  project: string;
  region: string;
  service: string;
  url: string | null;
  traffic: { revision: string; percent: number; latest: boolean }[];
  latestReady: string | null;
  /** Running container instances by revision and state, from Cloud Monitoring (lags ~3 min). */
  instanceCount: Got<{ revision: string; state: string; count: number }[]>;
  /** Latest heartbeat per instance inside the window. */
  instances: Got<(Heartbeat & { seen: string; cloudRunInstance: string | null })[]>;
  /** The instance /status.json reached just now (recent log dropped). */
  answering: Got<Omit<StatusReport, 'recent'>>;
  events: Got<{ at: string; instance: string | null; level: string; text: string }[]>;
}

const LOG = 'https://logging.googleapis.com/v2/entries:list';
const resourceFilter = (): string =>
  `resource.type="cloud_run_revision" resource.labels.service_name="${SERVICE}" resource.labels.location="${REGION}"`;
const sinceFilter = (): string => `timestamp>="${new Date(Date.now() - SINCE_MS).toISOString()}"`;

async function logEntries(filter: string, pageSize: number): Promise<LogEntry[]> {
  const out = await api<{ entries?: LogEntry[] }>(LOG, {
    resourceNames: [`projects/${PROJECT}`],
    filter,
    orderBy: 'timestamp desc',
    pageSize,
  });
  return out.entries ?? [];
}

async function heartbeats(): Promise<(Heartbeat & { seen: string; cloudRunInstance: string | null })[]> {
  const entries = await logEntries(`${resourceFilter()} ${sinceFilter()} jsonPayload.message="heartbeat"`, 1000);
  const latest = new Map<string, Heartbeat & { seen: string; cloudRunInstance: string | null }>();
  for (const e of entries) {
    const hb = e.jsonPayload as unknown as Heartbeat;
    if (!hb?.instance?.id || latest.has(hb.instance.id)) continue; // newest first
    latest.set(hb.instance.id, { ...hb, seen: e.timestamp, cloudRunInstance: e.labels?.instanceId ?? null });
  }
  return [...latest.values()].sort((a, b) => b.players - a.players || a.instance.id.localeCompare(b.instance.id));
}

/** The note() lines about people and rooms, newest first. */
async function events(): Promise<{ at: string; cloudRunInstance: string | null; level: string; text: string }[]> {
  if (EVENTS <= 0) return [];
  const verbs = ['joined', 'left', 'resumed in', 'disconnected from', 'timed out of', 'too far behind', 'opened room', 'closed idle room', 'error in'];
  const text = `textPayload:"[spectacle]" (${verbs.map((v) => `textPayload:"${v}"`).join(' OR ')})`;
  const entries = await logEntries(`${resourceFilter()} ${sinceFilter()} ${text}`, EVENTS);
  return entries.map((e) => ({
    at: e.timestamp,
    cloudRunInstance: e.labels?.instanceId ?? null,
    level: (e.severity ?? 'INFO').toLowerCase(),
    text: (e.textPayload ?? '').replace(/^\[spectacle\]\s*/, '').split('\n')[0],
  }));
}

async function instanceCount(): Promise<{ revision: string; state: string; count: number }[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60e3); // the metric lags; look back far enough to catch a point
  const q = new URLSearchParams({
    filter: `metric.type="run.googleapis.com/container/instance_count" resource.labels.service_name="${SERVICE}" resource.labels.location="${REGION}"`,
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '60s',
    'aggregation.perSeriesAligner': 'ALIGN_MAX',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
  });
  q.append('aggregation.groupByFields', 'resource.labels.revision_name');
  q.append('aggregation.groupByFields', 'metric.labels.state');
  const out = await api<{
    timeSeries?: { metric: { labels?: { state?: string } }; resource: { labels: { revision_name?: string } }; points: { value: { int64Value?: string; doubleValue?: number } }[] }[];
  }>(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${q}`);
  return (out.timeSeries ?? [])
    .map((s) => ({
      revision: s.resource.labels.revision_name ?? '?',
      state: s.metric.labels?.state ?? '?',
      count: Number(s.points[0]?.value.int64Value ?? s.points[0]?.value.doubleValue ?? 0), // points are newest first
    }))
    .filter((r) => r.count > 0);
}

interface RunService {
  uri?: string;
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  trafficStatuses?: { type?: string; revision?: string; percent?: number }[];
}

async function gatherCloudRun(): Promise<Picture> {
  const svc = await api<RunService>(`https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`);
  const short = (r?: string): string => (r ?? '').split('/').pop() ?? '';
  const latestReady = short(svc.latestReadyRevision) || null;
  const traffic = (svc.trafficStatuses ?? []).map((t) => {
    const latest = t.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST';
    return { revision: latest ? latestReady ?? 'latest' : short(t.revision), percent: t.percent ?? 0, latest };
  });
  const url = svc.uri ?? null;
  const [instances, answering, evs, count] = await Promise.all([
    got(heartbeats()),
    got(url ? fetchJson<StatusReport>(`${url}/status.json`).then(({ recent: _, ...r }) => r) : Promise.reject(new Error('service has no URL'))),
    got(events()),
    got(instanceCount()),
  ]);
  // Cloud Run's own instance id → the server's short id, so events name instances the way /status does.
  const shortId = new Map<string, string>();
  if (instances.ok) for (const i of instances.value) if (i.cloudRunInstance) shortId.set(i.cloudRunInstance, i.instance.id);
  const named: Picture['events'] = evs.ok
    ? {
        ok: true,
        value: evs.value.map((e) => ({
          at: e.at,
          instance: e.cloudRunInstance ? shortId.get(e.cloudRunInstance) ?? `~${e.cloudRunInstance.slice(-6)}` : null,
          level: e.level,
          text: e.text,
        })),
      }
    : evs;
  return { at: Date.now(), project: PROJECT, region: REGION, service: SERVICE, url, traffic, latestReady, instanceCount: count, instances, answering, events: named };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return (await res.json()) as T;
}

// --- print --------------------------------------------------------------------

function printCloudRun(p: Picture): void {
  const lines: string[] = [];
  lines.push(`${bold(p.service)}  ${p.url ?? dim('(no URL)')}  ${dim(`${p.project} · ${p.region} · ${clock(p.at)}`)}`);
  lines.push(
    `traffic   ${p.traffic.map((t) => `${t.revision} ${bold(`${t.percent}%`)}${t.latest ? dim(' (latest)') : ''}`).join('  ·  ') || dim('none')}`,
  );

  if (p.instanceCount.ok) {
    const byRev = new Map<string, string[]>();
    for (const r of p.instanceCount.value) byRev.set(r.revision, [...(byRev.get(r.revision) ?? []), `${r.count} ${r.state}`]);
    const total = p.instanceCount.value.reduce((n, r) => n + r.count, 0);
    lines.push(
      `running   ${bold(total)} instance${total === 1 ? '' : 's'}` +
        (byRev.size ? `  ${dim('(' + [...byRev].map(([rev, s]) => `${rev}: ${s.join(', ')}`).join('; ') + ')')}` : '') +
        dim('  · metric, ~3 min behind'),
    );
  } else lines.push(`running   ${yellow('?')} ${dim(p.instanceCount.error)}`);

  if (p.answering.ok) {
    const r = p.answering.value;
    const id = r.instance ? `${bold(cyan(r.instance.id))}${r.instance.revision ? ` (${r.instance.revision})` : ''}` : dim('unnamed (older build)');
    const humans = r.rooms.reduce((n, room) => n + room.players.filter((pl) => !pl.bot && pl.connected).length, 0);
    lines.push(
      `answering ${green('●')} ${id} · up ${ago(r.now - r.startedAt)} · ${humans} player${humans === 1 ? '' : 's'} · ${r.rooms.length} room${r.rooms.length === 1 ? '' : 's'}` +
        ` · rss ${r.memory.rssMb} MB · tick max ${r.tick.maxMs} ms  ${dim('/status.json, just now')}`,
    );
  } else lines.push(`answering ${red('●')} ${red(p.answering.error)}`);

  lines.push('');
  if (!p.instances.ok) lines.push(`${bold('INSTANCES')}  ${red(p.instances.error)}`);
  else {
    const list = p.instances.value;
    const players = list.reduce((n, i) => n + i.players, 0);
    lines.push(`${bold('INSTANCES')} with people on them  ${bold(list.length)} up · ${bold(players)} player${players === 1 ? '' : 's'}  ${dim(`(heartbeat in the last ${ago(SINCE_MS)}; idle instances don't beat)`)}`);
    if (list.length === 0) lines.push(dim('  nobody connected anywhere'));
    for (const i of list) {
      const stale = p.at - Date.parse(i.seen) > 150e3;
      const old = p.latestReady && i.instance.revision && i.instance.revision !== p.latestReady;
      lines.push(
        `  ${stale ? yellow('●') : green('●')} ${bold(cyan(i.instance.id))}  ${i.instance.revision ?? '?'}${old ? yellow(' (old revision)') : ''}` +
          `  up ${ago(p.at - Date.parse(i.startedAt))}  sockets ${i.sockets}  players ${bold(i.players)}  ${dim(`seen ${ago(p.at - Date.parse(i.seen))} ago`)}`,
      );
      for (const r of i.rooms) {
        lines.push(`      ${r.id.padEnd(14)} ${dim(r.mode.padEnd(9))} ${r.humans.length ? r.humans.join(', ') : dim('(bots only / joining)')}`);
      }
    }
  }

  if (EVENTS > 0) {
    lines.push('');
    if (!p.events.ok) lines.push(`${bold('RECENT')}  ${red(p.events.error)}`);
    else {
      lines.push(`${bold('RECENT')} joins, leaves and rooms  ${dim(`(newest first, last ${ago(SINCE_MS)})`)}`);
      if (p.events.value.length === 0) lines.push(dim('  nothing'));
      for (const e of p.events.value) {
        const lvl = e.level === 'error' ? red : e.level === 'warning' ? yellow : (s: string) => s;
        lines.push(`  ${dim(clock(e.at))}  ${cyan((e.instance ?? '?').padEnd(7))} ${lvl(e.text)}`);
      }
      if (p.events.value.some((e) => e.instance?.startsWith('~'))) {
        lines.push(dim('  ~id: Cloud Run\'s instance id — no heartbeat from it in the window (idle, gone, or a build before heartbeats)'));
      }
    }
  }
  output(lines);
}

function printDirect(url: string, r: StatusReport): void {
  const lines: string[] = [];
  const humans = r.rooms.flatMap((room) => room.players.filter((pl) => !pl.bot));
  const online = humans.filter((pl) => pl.connected).length;
  lines.push(`${bold(url)}  ${dim(clock(r.now))}`);
  lines.push(
    `${green('●')} instance ${bold(cyan(r.instance?.id ?? '?'))}${r.instance?.revision ? ` (${r.instance.revision})` : ''} · up ${ago(r.now - r.startedAt)} · ${r.field.family} level ${r.field.level}` +
      ` · rss ${r.memory.rssMb} MB · tick ${r.tick.avgMs}/${r.tick.maxMs} ms (every ${r.tick.everyMs})`,
  );
  lines.push(
    `sockets ${r.sockets} · players ${bold(online)} online${humans.length > online ? `, ${humans.length - online} held for resume` : ''}` +
      ` · joins ${r.counters.joins} resumes ${r.counters.resumes} leaves ${r.counters.leaves} dropped ${r.counters.dropped} errors ${r.counters.errors ? red(r.counters.errors) : 0}`,
  );
  lines.push('');
  lines.push(`${bold('ROOMS')} ${r.rooms.length}`);
  for (const room of r.rooms) {
    const people = room.players
      .filter((pl) => !pl.bot)
      .map((pl) => (pl.connected ? pl.name : dim(`${pl.name} (away)`)) + dim(` ${pl.score}`));
    const bots = room.players.length - people.length;
    lines.push(
      `  ${room.id.padEnd(14)} ${dim(room.mode.padEnd(9))} ${people.join(', ') || dim('no humans')}${bots ? dim(`  +${bots} bot${bots === 1 ? '' : 's'}`) : ''}` +
        (room.emptySince ? dim(`  empty ${ago(r.now - room.emptySince)}`) : ''),
    );
  }
  if (EVENTS > 0) {
    lines.push('');
    lines.push(bold('RECENT'));
    for (const l of r.recent.slice(0, EVENTS)) {
      const lvl = l.level === 'error' ? red : l.level === 'warn' ? yellow : (s: string) => s;
      lines.push(`  ${dim(clock(l.at))}  ${lvl(l.text)}`);
    }
  }
  output(lines);
}

function output(lines: string[]): void {
  if (WATCH_S && tty) process.stdout.write('\x1b[2J\x1b[H');
  console.log(lines.join('\n'));
  if (WATCH_S) console.log(dim(`\nevery ${WATCH_S}s · ctrl-c to stop`));
}

// --- main ---------------------------------------------------------------------

async function once(): Promise<void> {
  if (DIRECT_URL) {
    const base = DIRECT_URL.replace(/\/+$/, '').replace(/\/status(\.json)?$/, '');
    const r = await fetchJson<StatusReport>(`${base}/status.json`);
    if (JSON_OUT) console.log(JSON.stringify(r, null, 2));
    else printDirect(base, r);
    return;
  }
  const p = await gatherCloudRun();
  if (JSON_OUT) console.log(JSON.stringify(p, null, 2));
  else printCloudRun(p);
}

async function main(): Promise<void> {
  for (;;) {
    try {
      await once();
    } catch (e) {
      if (!WATCH_S) throw e;
      console.error(red(e instanceof Error ? e.message : String(e)));
    }
    if (!WATCH_S) return;
    await new Promise((r) => setTimeout(r, WATCH_S * 1000));
  }
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
