/**
 * Runs in every test worker (vitest.config.ts `setupFiles`). Vitest runs each
 * file in a forked worker, and a worker never notices vitest itself being
 * killed outright: it carries on under init, spinning, along with any server
 * it started (tests/server.ts). Its IPC channel to vitest closes either way,
 * so go when it does — by signal, as vitest makes process.exit throw in a test.
 */
process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));
