/** The solo lobby's bot picker: what a `?bots=` link or a saved choice starts it on. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOLO_BOTS, soloBotsFrom } from '../client/src/local';
import { BOT_KINDS } from '../shared/game/bots';

describe('solo bots', () => {
  it('one of each kind by default, the Edge Lords included', () => {
    expect(DEFAULT_SOLO_BOTS).toEqual(Object.fromEntries(BOT_KINDS.map((k) => [k, 1])));
    expect(DEFAULT_SOLO_BOTS.edgelord).toBe(1);
    expect(DEFAULT_SOLO_BOTS.lazylord).toBe(1);
  });

  it('a choice saved before a kind existed gives that kind its default; the rest stay as picked', () => {
    // Saved by a lobby that knew the first five kinds (every kind, zeros too).
    const bots = soloBotsFrom('wanderer:2,rotator:0,hunter:1,farmer:0,bridge:3', true);
    expect(bots).toEqual({ wanderer: 2, rotator: 0, hunter: 1, farmer: 0, bridge: 3, edgelord: 1, lazylord: 1 });
    // A kind saved at zero stays at zero.
    expect(soloBotsFrom('wanderer:1,rotator:0,hunter:0,farmer:0,bridge:0,edgelord:0,lazylord:2', true)).toMatchObject({ edgelord: 0, lazylord: 2 });
  });

  it('a ?bots= link means exactly what it lists', () => {
    expect(soloBotsFrom('edgelord+hunter:2', false)).toEqual({ wanderer: 0, rotator: 0, hunter: 2, farmer: 0, bridge: 0, edgelord: 1, lazylord: 0 });
  });
});
