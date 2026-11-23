import { describe, expect, it } from 'vitest';
import { cleanReaction, QUICK_REACTIONS, shownReactions } from './types';

describe('reactions', () => {
  it('accepts emoji, including the quick set', () => {
    for (const e of QUICK_REACTIONS) expect(cleanReaction(e)).toBe(e);
    expect(cleanReaction(' 👍🏽 ')).toBe('👍🏽');
    expect(cleanReaction('👨‍👩‍👧')).toBe('👨‍👩‍👧');
  });

  it('rejects text, empty and oversized values', () => {
    expect(cleanReaction('lol')).toBeNull();
    expect(cleanReaction('7')).toBeNull();
    expect(cleanReaction('')).toBeNull();
    expect(cleanReaction('👍\n')).toBe('👍');
    expect(cleanReaction('👍\u0000')).toBeNull();
    expect(cleanReaction('👍'.repeat(9))).toBeNull();
    expect(cleanReaction(null)).toBeNull();
  });

  it('lists set reactions, theirs first, skipping removals', () => {
    expect(shownReactions({})).toEqual([]);
    expect(
      shownReactions({ reactions: { me: { emoji: '❤️', ts: 2 }, peer: { emoji: '😂', ts: 1 } } }),
    ).toEqual([
      { who: 'peer', emoji: '😂' },
      { who: 'me', emoji: '❤️' },
    ]);
    expect(shownReactions({ reactions: { me: { emoji: null, ts: 3 } } })).toEqual([]);
  });
});
