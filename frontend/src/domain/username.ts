/** Usernames: a unique, editable alias for the (fixed, key-derived) user code. Mirrors the server rules. */
export const USERNAME_RULES = '3–20 characters: letters, numbers and _';

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(username);
}
