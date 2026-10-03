/**
 * The real game server (server/index.ts) for integration tests, started on a
 * port and stopped for good.
 *
 * Node runs the server itself (`--import tsx`), so `stop()` kills the server.
 * Spawning `npx tsx server/index.ts` killed only the npx wrapper and left the
 * server running under init: every run leaked some. EXIT_WITH_PARENT covers a
 * run that never reaches `stop()`: the server's stdin is a pipe from this
 * worker, and it exits when that closes, however the worker goes (and
 * tests/setup.ts makes it go when vitest does).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface TestServer {
  /** Kill the server and wait until it has exited. */
  stop(): Promise<void>;
}

/** Start the server on `port` with `env` over ours, and wait for its /health. */
export async function startServer(port: number, env: Record<string, string> = {}): Promise<TestServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), EXIT_WITH_PARENT: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const stop = async () => {
    if (running()) child.kill();
    await exited;
  };
  for (let i = 0; i < 200 && running(); i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { stop };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const why = running() ? 'did not come up' : `exited (${child.exitCode ?? child.signalCode}) before it came up`;
  await stop();
  throw new Error(`server on port ${port} ${why}`);
}
