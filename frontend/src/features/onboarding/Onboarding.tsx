/** First-run flow (spec F1): install guide → profile + password → keys/vault/registration → code. */
import { useEffect, useState, type FormEvent } from 'react';
import { Spinner } from '@/components/ui';
import { formatCode } from '@/lib/crypto/code';
import { passwordStrength } from '@/lib/crypto/vault';
import { canPromptInstall, isAndroid, isIOS, isStandalone, onInstallAvailable, promptInstall } from '@/lib/platform';
import { createAccount } from '@/services/account';
import { importBackup } from '@/services/backup';
import { useSession } from '@/state/session';

type Step = 'install' | 'profile' | 'restore' | 'working' | 'done';

export function Onboarding() {
  const [step, setStep] = useState<Step>(isStandalone() ? 'profile' : 'install');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const finish = (c: string) => {
    setCode(c);
    setStep('done');
  };

  return (
    <div className="screen">
      <div className="scroll">
        <div className="content stack" style={{ paddingTop: 'calc(var(--safe-top) + 24px)', maxWidth: 520, margin: '0 auto' }}>
          {!isStandalone() && isIOS() && step !== 'install' && <IosBanner />}
          {step === 'install' && <InstallGuide onContinue={() => setStep('profile')} />}
          {step === 'profile' && (
            <ProfileForm
              error={error}
              onRestore={() => setStep('restore')}
              onSubmit={async (name, pw) => {
                setError('');
                setStep('working');
                try {
                  finish(await createAccount(name, pw));
                } catch (e) {
                  setError(e instanceof Error ? `Setup failed: ${e.message}` : 'Setup failed');
                  setStep('profile');
                }
              }}
            />
          )}
          {step === 'restore' && (
            <RestoreForm
              error={error}
              onBack={() => setStep('profile')}
              onSubmit={async (file, passphrase, pw) => {
                setError('');
                setStep('working');
                try {
                  finish(await importBackup(file, passphrase, pw));
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Restore failed');
                  setStep('restore');
                }
              }}
            />
          )}
          {step === 'working' && (
            <div className="center stack" style={{ paddingTop: 80 }}>
              <Spinner label="Setting up" />
              <p className="muted">Creating your keys and secure storage…</p>
            </div>
          )}
          {step === 'done' && <Done code={code} />}
        </div>
      </div>
    </div>
  );
}

function IosBanner() {
  return (
    <div className="banner" role="note">
      You are using Safari in a browser tab. Notifications and reliable storage only work after you install: tap{' '}
      <strong>Share</strong> → <strong>Add to Home Screen</strong>, then open it from there.
    </div>
  );
}

function InstallGuide({ onContinue }: { onContinue: () => void }) {
  const [canInstall, setCanInstall] = useState(canPromptInstall());
  useEffect(() => onInstallAvailable(() => setCanInstall(true)), []);
  return (
    <>
      <h1 style={{ margin: 0 }}>Welcome</h1>
      <p className="muted">Install this app on your phone for the best experience.</p>
      {isIOS() && (
        <div className="card content stack" style={{ padding: 16 }}>
          <strong>iPhone / iPad</strong>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>Tap the <strong>Share</strong> button in Safari.</li>
            <li>Choose <strong>Add to Home Screen</strong>.</li>
            <li>Open <strong>Tasks</strong> from your Home Screen and continue there.</li>
          </ol>
          <p className="small muted" style={{ margin: 0 }}>
            Notifications and reliable storage need the Home Screen install (iOS 16.4 or later).
          </p>
        </div>
      )}
      {(isAndroid() || !isIOS()) && (
        <div className="card stack" style={{ padding: 16 }}>
          <strong>Android / desktop</strong>
          {canInstall ? (
            <button className="btn" onClick={() => void promptInstall()}>
              Install app
            </button>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Use the browser menu → <strong>Install app</strong> / <strong>Add to Home screen</strong>.
            </p>
          )}
        </div>
      )}
      <button className="btn secondary block" onClick={onContinue}>
        Continue here
      </button>
    </>
  );
}

function ProfileForm({
  onSubmit,
  onRestore,
  error,
}: {
  onSubmit: (name: string, pw: string) => void;
  onRestore: () => void;
  error: string;
}) {
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const strength = passwordStrength(pw);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const valid = name.trim().length >= 1 && name.trim().length <= 40 && pw.length >= 8 && pw === pw2;
  const colors = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#15803d'];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(name.trim(), pw);
  };

  return (
    <form className="stack" onSubmit={submit}>
      <h1 style={{ margin: 0 }}>Set up</h1>
      <label className="field">
        Display name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="nickname" />
      </label>
      <label className="field">
        Password (at least 8 characters)
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </label>
      {pw && (
        <div aria-live="polite">
          <div className="strength">
            <div style={{ width: `${(strength.score + 1) * 20}%`, background: colors[strength.score] }} />
          </div>
          <span className="tiny muted">{strength.label}</span>
        </div>
      )}
      <label className="field">
        Confirm password
        <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </label>
      {mismatch && <span className="error-text">Passwords do not match.</span>}
      {error && <span className="error-text">{error}</span>}
      <button className="btn block" type="submit" disabled={!valid}>
        Create
      </button>
      <button className="btn ghost" type="button" onClick={onRestore}>
        Restore from a backup instead
      </button>
    </form>
  );
}

function RestoreForm({
  onSubmit,
  onBack,
  error,
}: {
  onSubmit: (file: File, passphrase: string, pw: string) => void;
  onBack: () => void;
  error: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const valid = file && passphrase && pw.length >= 8 && pw === pw2;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(file!, passphrase, pw);
      }}
    >
      <h1 style={{ margin: 0 }}>Restore</h1>
      <p className="muted small" style={{ margin: 0 }}>
        Backups only work on the same web address they were created on.
      </p>
      <label className="field">
        Backup file
        <input className="input" type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="field">
        Backup passphrase
        <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </label>
      <label className="field">
        New device password
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="field">
        Confirm device password
        <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </label>
      {error && <span className="error-text">{error}</span>}
      <button className="btn block" type="submit" disabled={!valid}>
        Restore
      </button>
      <button className="btn ghost" type="button" onClick={onBack}>
        Back
      </button>
    </form>
  );
}

function Done({ code }: { code: string }) {
  const setPhase = useSession((s) => s.setPhase);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatCode(code));
      setCopied(true);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="stack center" style={{ paddingTop: 24 }}>
      <h1 style={{ margin: 0 }}>You're all set</h1>
      <p className="muted" style={{ margin: 0 }}>
        Your code. Share it with people you want to talk to.
      </p>
      <div className="card mono" style={{ padding: '16px 20px', fontSize: '1.4rem' }}>
        {formatCode(code)}
      </div>
      <button className="btn secondary" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy code'}
      </button>
      <button className="btn block" onClick={() => setPhase('tasks')}>
        Continue
      </button>
    </div>
  );
}
