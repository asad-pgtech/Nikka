import { describe, expect, it } from 'vitest';
import { formatLastSeen, formatTime } from './format';

describe('formatLastSeen', () => {
  const now = new Date(2025, 0, 15, 15, 0).getTime();

  it('says just now within a minute', () => {
    expect(formatLastSeen(now - 30_000, now)).toBe('last seen just now');
  });

  it('uses today / yesterday with the time', () => {
    const today = new Date(2025, 0, 15, 9, 5).getTime();
    expect(formatLastSeen(today, now)).toBe(`last seen today at ${formatTime(today)}`);
    const yest = new Date(2025, 0, 14, 23, 0).getTime();
    expect(formatLastSeen(yest, now)).toBe(`last seen yesterday at ${formatTime(yest)}`);
  });

  it('falls back to a date for older times', () => {
    const old = new Date(2025, 0, 1, 9, 5).getTime();
    expect(formatLastSeen(old, now)).toMatch(/^last seen .+ at /);
    expect(formatLastSeen(old, now)).not.toContain('today');
  });
});
