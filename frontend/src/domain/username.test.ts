import { describe, expect, it } from 'vitest';
import { isValidUsername, normalizeUsername } from './username';

describe('username', () => {
  it('normalizes case, whitespace and a leading @', () => {
    expect(normalizeUsername('  @Alice_1 ')).toBe('alice_1');
  });

  it('accepts 3-20 of a-z 0-9 _', () => {
    expect(isValidUsername('bob')).toBe(true);
    expect(isValidUsername('a_1'.padEnd(20, 'x'))).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('x'.repeat(21))).toBe(false);
    expect(isValidUsername('bad-name')).toBe(false);
    expect(isValidUsername('Alice')).toBe(false);
  });
});
