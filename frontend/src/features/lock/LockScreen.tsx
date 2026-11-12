/**
 * Looks like an ordinary app lock for a to-do app. A wrong password silently shows the task list
 * (spec F2): no error, shake, toast or retry hint.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '@/components/Icon';
import { Spinner } from '@/components/ui';
import { attemptUnlock } from '@/services/session';
import { useSession } from '@/state/session';

export function LockScreen() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setPhase = useSession((s) => s.setPhase);
  const setPendingRef = useSession((s) => s.setPendingRef);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    const pw = password;
    setPassword('');
    inputRef.current?.blur();
    await attemptUnlock(pw);
  };

  const cancel = () => {
    setPendingRef(null);
    setPhase('tasks');
  };

  return (
    <div className="screen">
      <form className="center lock stack" onSubmit={submit} style={{ flex: 1, justifyContent: 'flex-start' }}>
        <div className="lock-icon">
          <Icon name="lock" size={32} />
        </div>
        <h2 style={{ margin: 0 }}>Tasks is locked</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Enter your passcode to continue
        </p>
        <input
          ref={inputRef}
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Passcode"
          placeholder="Passcode"
          disabled={busy}
          style={{ maxWidth: 320, textAlign: 'center' }}
        />
        {busy ? (
          <Spinner label="Unlocking" />
        ) : (
          <div className="row" style={{ maxWidth: 320, width: '100%' }}>
            <button type="button" className="btn secondary grow" onClick={cancel}>
              Cancel
            </button>
            <button type="submit" className="btn grow" disabled={!password}>
              Unlock
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
