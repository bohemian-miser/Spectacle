/**
 * Player feedback, the triage half (server/feedback.ts takes the reports
 * in). The feedback-triage workflow runs `pull` and `apply` itself; its
 * Gemini agent only runs `mark`, so the agent never holds credentials for
 * the store.
 *
 *   npm run feedback -- pull [--limit N]
 *       Untriaged reports, oldest first, as the agent may see them (no
 *       contact, an infinite-line rule left unnamed): JSON on stdout and in
 *       .triage/queue.json.
 *   npm run feedback -- mark <id> --issue <n>
 *   npm run feedback -- mark <id> --skip "<reason>"
 *       Record what became of a queued report in .triage/ledger.jsonl, at
 *       once, so a run that dies halfway still keeps what it did.
 *   npm run feedback -- apply
 *       Move every report in the ledger (and in the queue, when there is
 *       one) to triaged/ with its outcome; the ledger keeps only the ones
 *       that failed.
 *
 * FEEDBACK_URL picks the store as on the server: `gs://bucket/prefix` (with
 * `gcloud auth print-access-token`'s credentials) or a directory.
 * TRIAGE_DIR moves .triage/.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedbackStore, toTriageItem, type TriageItem, type Triage } from '../server/feedback';

const TRIAGE_DIR = process.env.TRIAGE_DIR ?? '.triage';
const QUEUE = join(TRIAGE_DIR, 'queue.json');
const LEDGER = join(TRIAGE_DIR, 'ledger.jsonl');

type Decision = { id: string; status: 'filed'; issue: number } | { id: string; status: 'skipped'; reason: string };

function die(msg: string): never {
  console.error(msg);
  console.error('Usage: feedback.ts pull [--limit N] | mark <id> --issue <n> | mark <id> --skip "<reason>" | apply');
  process.exit(1);
}

function store() {
  const url = process.env.FEEDBACK_URL;
  if (!url) die('Set FEEDBACK_URL (gs://bucket/prefix or a directory).');
  let token: string | null = null;
  return feedbackStore(url, async () => (token ??= execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()));
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function pull(args: string[]): Promise<void> {
  const limit = Number(option(args, '--limit') ?? 30);
  if (!Number.isInteger(limit) || limit < 1) die('Invalid --limit');
  const s = store();
  const ids = await s.untriaged();
  const items: TriageItem[] = [];
  for (const id of ids.slice(0, limit)) {
    try {
      items.push(toTriageItem(await s.read(id)));
    } catch (e) {
      console.error(`skipping unreadable report ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  mkdirSync(TRIAGE_DIR, { recursive: true });
  writeFileSync(QUEUE, JSON.stringify(items, null, 2));
  console.log(JSON.stringify(items, null, 2));
  console.error(`${items.length} of ${ids.length} untriaged reports (limit ${limit}) → ${QUEUE}`);
}

function mark(args: string[]): void {
  const [id] = args;
  if (!id) die('mark needs a report id');
  if (!existsSync(QUEUE)) die(`No ${QUEUE}: nothing has been pulled.`);
  const queued = (JSON.parse(readFileSync(QUEUE, 'utf8')) as TriageItem[]).map((q) => q.id);
  if (!queued.includes(id)) die(`${id} is not in ${QUEUE}`);
  const issue = option(args, '--issue');
  const reason = option(args, '--skip');
  if ((issue === undefined) === (reason === undefined)) die('mark needs exactly one of --issue <n> or --skip "<reason>"');
  let decision: Decision;
  if (issue !== undefined) {
    const n = Number(issue);
    if (!Number.isInteger(n) || n < 1) die('Invalid --issue number');
    decision = { id, status: 'filed', issue: n };
  } else {
    if (!reason?.trim()) die('--skip needs a reason');
    decision = { id, status: 'skipped', reason: reason.trim().slice(0, 200) };
  }
  appendFileSync(LEDGER, `${JSON.stringify(decision)}\n`);
  console.log(`Marked ${id}: ${decision.status === 'filed' ? `issue #${decision.issue}` : `skipped (${decision.reason})`}`);
}

async function apply(): Promise<void> {
  if (!existsSync(LEDGER)) {
    console.log('Nothing to apply: no ledger.');
    return;
  }
  // The last word on a report wins: an agent may correct itself.
  const decisions = new Map<string, Decision>();
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as Decision;
      decisions.set(d.id, d);
    } catch {
      console.error(`ignoring a bad ledger line: ${line.slice(0, 120)}`);
    }
  }
  // The agent could write the ledger by hand: only what was pulled counts.
  if (existsSync(QUEUE)) {
    const queued = new Set((JSON.parse(readFileSync(QUEUE, 'utf8')) as TriageItem[]).map((q) => q.id));
    for (const id of decisions.keys()) {
      if (!queued.has(id)) {
        console.error(`ignoring ${id}: it was not pulled`);
        decisions.delete(id);
      }
    }
  }
  const s = store();
  const at = new Date().toISOString();
  const failed: Decision[] = [];
  for (const d of decisions.values()) {
    const triage: Triage = d.status === 'filed' ? { status: 'filed', issue: d.issue, at } : { status: 'skipped', reason: d.reason, at };
    try {
      await s.settle(d.id, triage);
      console.log(`${d.id} → triaged (${d.status === 'filed' ? `#${d.issue}` : 'skipped'})`);
    } catch (e) {
      failed.push(d);
      console.error(`${d.id} not moved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  writeFileSync(LEDGER, failed.map((d) => `${JSON.stringify(d)}\n`).join(''));
  if (failed.length) {
    console.error(`${failed.length} of ${decisions.size} not applied; they stay in ${LEDGER} and come back on the next pull.`);
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'pull') await pull(rest);
else if (cmd === 'mark') mark(rest);
else if (cmd === 'apply') await apply();
else die(`Unknown command: ${cmd ?? '(none)'}`);
