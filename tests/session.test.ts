/**
 * The resume ticket: per tab in sessionStorage, plus a shared copy in
 * localStorage that a new tab falls back on while it is fresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, forgetSession, loadSession, saveSession, SHARED_MAX_AGE_MS, touchSession, type SavedSession } from '../client/src/session';
import { defaultRule } from '../shared/game/rule';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const ticket = (id: string, name = 'Ann'): SavedSession => ({ name, rule: defaultRule('hex'), resume: { id, token: `t-${id}` }, mode: 'normal', room: 'normal-1' });

/** A new tab: its own sessionStorage, the browser's localStorage. */
function newTab(): void {
  vi.stubGlobal('sessionStorage', new MemoryStorage());
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  newTab();
});

describe('session', () => {
  it("a tab's own ticket wins over the shared copy", () => {
    saveSession(ticket('p1'), 1000);
    newTab();
    saveSession(ticket('p2', 'Bob'), 2000);
    // Back in a tab that has its own: p2, not shared.
    expect(loadSession(2000)).toMatchObject({ resume: { id: 'p2' }, shared: false });
  });

  it('a new tab picks up the last ticket while it is fresh', () => {
    saveSession(ticket('p1'), 1000);
    newTab();
    expect(loadSession(1000 + SHARED_MAX_AGE_MS - 1)).toMatchObject({ name: 'Ann', resume: { id: 'p1', token: 't-p1' }, mode: 'normal', room: 'normal-1', shared: true });
    expect(loadSession(1000 + SHARED_MAX_AGE_MS + 1)).toBeNull();
  });

  it('touching keeps the shared copy fresh, only for its own player', () => {
    saveSession(ticket('p1'), 1000);
    touchSession('p1', 1000 + SHARED_MAX_AGE_MS);
    touchSession('p9', 1000 + 3 * SHARED_MAX_AGE_MS);
    newTab();
    expect(loadSession(1000 + 2 * SHARED_MAX_AGE_MS - 1)?.resume.id).toBe('p1');
    expect(loadSession(1000 + 2 * SHARED_MAX_AGE_MS + 1)).toBeNull();
  });

  it("clearing drops only the tab's ticket; forgetting drops the shared copy of the same player", () => {
    saveSession(ticket('p1'), 1000);
    clearSession();
    expect(loadSession(1000)).toMatchObject({ resume: { id: 'p1' }, shared: true });

    saveSession(ticket('p1'), 1000);
    forgetSession();
    expect(loadSession(1000)).toBeNull();
  });

  it("forgetting a player leaves another tab's shared copy alone", () => {
    saveSession(ticket('p1'), 1000);
    const tabA = sessionStorage;
    newTab();
    saveSession(ticket('p2', 'Bob'), 2000);
    vi.stubGlobal('sessionStorage', tabA);
    forgetSession(); // tab A's player leaves
    newTab();
    expect(loadSession(2000)).toMatchObject({ resume: { id: 'p2' }, shared: true });
  });
});
