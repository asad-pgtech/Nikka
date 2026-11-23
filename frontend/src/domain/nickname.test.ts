import { describe, expect, it } from 'vitest';
import { cleanNickname, contactName } from './types';

describe('nicknames', () => {
  it('shows the nickname when set, else the display name', () => {
    expect(contactName({ displayName: 'Bob', nickname: 'Bobby' })).toBe('Bobby');
    expect(contactName({ displayName: 'Bob' })).toBe('Bob');
  });

  it('cleans and validates input', () => {
    expect(cleanNickname('  Bobby  ')).toBe('Bobby');
    expect(cleanNickname('Bo\u0000b\n')).toBe('Bob');
    expect(cleanNickname('   ')).toBeNull();
    expect(cleanNickname('x'.repeat(41))).toBeNull();
    expect(cleanNickname('😀'.repeat(40))).toBe('😀'.repeat(40));
    expect(cleanNickname(42)).toBeNull();
  });
});
