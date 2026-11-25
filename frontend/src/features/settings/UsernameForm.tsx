/** Pick or change the unique username (an alias for the fixed user code). */
import { useState, type FormEvent } from 'react';
import { Sheet } from '@/components/ui';
import { isValidUsername, normalizeUsername, USERNAME_RULES } from '@/domain/username';
import { ApiError } from '@/lib/api/http';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';

export function UsernameForm({ initial = '', onDone }: { initial?: string; onDone?: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const username = normalizeUsername(value);
  const valid = isValidUsername(username);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    if (username === initial) return onDone?.();
    setBusy(true);
    setError('');
    try {
      await getController().updateProfile({ username });
      onDone?.();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username_taken'
          ? 'That username is taken. Try another.'
          : 'Could not save. Are you connected?',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <input
        className="input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={21}
        aria-label="Username"
        placeholder="e.g. alice_92"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="username"
      />
      <span className={`tiny ${value && !valid ? 'error-text' : 'muted'}`}>{USERNAME_RULES}. Must be unique.</span>
      {error && <span className="error-text">{error}</span>}
      <button className="btn" disabled={busy || !valid}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

/** Blocking prompt for accounts created before usernames existed (or restored from a backup). */
export function UsernameRequired() {
  const missing = useChat((s) => s.me?.username === null);
  if (!missing) return null;
  return (
    <Sheet title="Choose a username" onClose={() => undefined}>
      <p className="muted small" style={{ marginTop: 0 }}>
        People can now find you by username instead of your code. Pick one to continue.
      </p>
      <UsernameForm />
    </Sheet>
  );
}
