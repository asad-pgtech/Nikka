import { describe, expect, it } from 'vitest';
import { deriveCode, formatCode, normalizeCode } from './code';

describe('user code', () => {
  it('matches the protocol test vectors', async () => {
    expect(await deriveCode(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe('EE8WUCD8SJTQ');
    expect(await deriveCode(new Uint8Array(32))).toBe('ETN9PDHSECYR');
  });

  it('normalizes case and dashes, rejects invalid input', () => {
    expect(normalizeCode('ee8w-ucd8-sjtq')).toBe('EE8WUCD8SJTQ');
    expect(normalizeCode(' EE8W UCD8SJTQ ')).toBe('EE8WUCD8SJTQ');
    expect(normalizeCode('EE8W-UCD8')).toBeNull(); // no partial matches
    expect(normalizeCode('EE8W-UCD8-SJT0')).toBeNull(); // 0 not in alphabet
  });

  it('formats as XXXX-XXXX-XXXX', () => {
    expect(formatCode('EE8WUCD8SJTQ')).toBe('EE8W-UCD8-SJTQ');
  });
});
