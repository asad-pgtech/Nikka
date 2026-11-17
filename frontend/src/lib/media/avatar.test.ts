import { describe, expect, it } from 'vitest';
import { isValidAvatar } from './thumbnails';

describe('isValidAvatar', () => {
  it('accepts small inline images', () => {
    expect(isValidAvatar('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(true);
    expect(isValidAvatar('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('rejects anything that is not a small inline raster image', () => {
    expect(isValidAvatar(null)).toBe(false);
    expect(isValidAvatar('https://example.com/a.jpg')).toBe(false);
    expect(isValidAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isValidAvatar('data:text/html;base64,PGgxPg==')).toBe(false);
    expect(isValidAvatar('data:image/jpeg;base64,AAAA"onerror=x')).toBe(false);
    expect(isValidAvatar(`data:image/jpeg;base64,${'A'.repeat(60_000)}`)).toBe(false);
  });
});
