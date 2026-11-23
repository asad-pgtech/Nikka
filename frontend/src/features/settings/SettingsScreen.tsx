/** Settings (spec F11) and encrypted backup (F12). */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Avatar, Sheet, Toggle } from '@/components/ui';
import { formatCode } from '@/lib/crypto/code';
import { makeAvatar } from '@/lib/media/thumbnails';
import { AvatarCropper } from './AvatarCropper';
import { isIOS, isStandalone } from '@/lib/platform';
import { exportBackup } from '@/services/backup';
import { disablePush, enablePush, pushUnavailableReason, sendTestPush } from '@/services/push';
import { changePassword, getController, lock, wipeAll } from '@/services/session';
import { useChat } from '@/state/chat';

const AUTOLOCK_OPTIONS = [
  { v: 30, label: '30 seconds' },
  { v: 60, label: '1 minute' },
  { v: 120, label: '2 minutes' },
  { v: 300, label: '5 minutes' },
  { v: 900, label: '15 minutes' },
];

type Panel = null | 'name' | 'password' | 'backup' | 'wipe' | 'blocked';

export function SettingsScreen() {
  const me = useChat((s) => s.me);
  const settings = useChat((s) => s.settings);
  const friends = useChat((s) => s.friends);
  const [qr, setQr] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [note, setNote] = useState('');
  const ctrl = getController();
  const blocked = friends.filter((f) => f.status === 'blocked' && f.blocked_by_me);

  useEffect(() => {
    if (me) void QRCode.toDataURL(formatCode(me.code), { margin: 1, width: 400 }).then(setQr);
  }, [me]);

  if (!me) return null;

  const safe = async (fn: () => Promise<void>) => {
    setNote('');
    try {
      await fn();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  return (
    <>
      <header className="topbar">
        <h1>Settings</h1>
        <button className="btn small secondary" onClick={lock}>
          Lock
        </button>
      </header>
      <div className="scroll">
        <div className="content">
          {isIOS() && !isStandalone() && (
            <div className="banner" style={{ marginBottom: 12 }}>
              Install to the Home Screen (Share → Add to Home Screen) for notifications and reliable storage.
            </div>
          )}
          {note && (
            <p className="error-text" role="alert">
              {note}
            </p>
          )}

          <div className="card center stack" style={{ padding: 16 }}>
            {qr && (
              <div className="qr">
                <img src={qr} alt={`QR code for ${formatCode(me.code)}`} />
              </div>
            )}
            <div className="mono" style={{ fontSize: '1.2rem' }}>
              {formatCode(me.code)}
            </div>
            <button className="btn small secondary" onClick={() => void navigator.clipboard?.writeText(formatCode(me.code))}>
              Copy code
            </button>
          </div>

          <div className="section-title">Profile</div>
          <ProfilePicture name={me.displayName} avatar={me.avatar} onError={setNote} />
          <div className="list">
            <button className="list-item" onClick={() => setPanel('name')}>
              <span className="grow">Display name</span>
              <span className="muted">{me.displayName}</span>
            </button>
            <div className="list-item">
              <div className="grow">
                Discoverable on network
                <div className="tiny muted">When off, people can still find you by your exact code.</div>
              </div>
              <Toggle
                label="Discoverable on network"
                checked={me.discoverable}
                onChange={(v) => void safe(() => ctrl.updateProfile({ discoverable: v }))}
              />
            </div>
          </div>

          <div className="section-title">Privacy</div>
          <div className="list">
            <div className="list-item">
              <span className="grow">Read receipts</span>
              <Toggle label="Read receipts" checked={settings.readReceipts} onChange={(v) => void ctrl.updateSettings({ readReceipts: v })} />
            </div>
            <div className="list-item">
              <div className="grow">
                Last seen
                <div className="tiny muted">When off, friends can't see yours and you can't see theirs.</div>
              </div>
              <Toggle
                label="Last seen"
                checked={me.showLastSeen}
                onChange={(v) => void safe(() => ctrl.updateProfile({ showLastSeen: v }))}
              />
            </div>
            <label className="list-item">
              <span className="grow">Auto-lock</span>
              <select
                className="input"
                style={{ width: 'auto', minHeight: 36, padding: '4px 8px' }}
                value={settings.autoLockSeconds}
                onChange={(e) => void ctrl.updateSettings({ autoLockSeconds: Number(e.target.value) })}
              >
                {AUTOLOCK_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <NotificationsRow />
            <button className="list-item" onClick={() => setPanel('blocked')}>
              <span className="grow">Blocked users</span>
              <span className="muted">{blocked.length}</span>
            </button>
          </div>

          <div className="section-title">Security</div>
          <div className="list">
            <button className="list-item" onClick={() => setPanel('password')}>
              Change password
            </button>
            <button className="list-item" onClick={() => setPanel('backup')}>
              Export encrypted backup
            </button>
            <button className="list-item" style={{ color: 'var(--danger)' }} onClick={() => setPanel('wipe')}>
              Wipe all data on this device
            </button>
          </div>
        </div>
      </div>

      {panel === 'name' && <NamePanel initial={me.displayName} onClose={() => setPanel(null)} />}
      {panel === 'password' && <PasswordPanel onClose={() => setPanel(null)} />}
      {panel === 'backup' && <BackupPanel onClose={() => setPanel(null)} />}
      {panel === 'wipe' && <WipePanel onClose={() => setPanel(null)} />}
      {panel === 'blocked' && (
        <Sheet title="Blocked users" onClose={() => setPanel(null)}>
          {blocked.length === 0 ? (
            <p className="muted">Nobody is blocked.</p>
          ) : (
            blocked.map((f) => (
              <div key={f.code} className="row" style={{ padding: '8px 0' }}>
                <div className="grow">
                  <div>{f.display_name}</div>
                  <div className="tiny muted mono">{formatCode(f.code)}</div>
                </div>
                <button className="btn small secondary" onClick={() => void safe(() => ctrl.friendAction(f.code, 'unblock'))}>
                  Unblock
                </button>
              </div>
            ))
          )}
        </Sheet>
      )}
    </>
  );
}

function ProfilePicture({ name, avatar, onError }: { name: string; avatar?: string; onError: (msg: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const apply = async (fn: () => Promise<void>) => {
    onError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not update the picture.');
    } finally {
      setBusy(false);
    }
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again
    if (!file) return;
    onError('');
    if (!file.type.startsWith('image/')) onError('Please choose an image.');
    else setPicked(file);
  };
  return (
    <div className="avatar-edit">
      <button
        className="icon-btn"
        style={{ width: 'auto', height: 'auto', padding: 0, borderRadius: 48 }}
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label="Change profile picture"
      >
        <Avatar name={name} src={avatar} large />
      </button>
      <div className="row">
        <button className="btn small secondary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Saving…' : avatar ? 'Change photo' : 'Add photo'}
        </button>
        {avatar && (
          <button
            className="btn small ghost"
            style={{ color: 'var(--danger)' }}
            onClick={() => void apply(() => getController().setAvatar(null))}
            disabled={busy}
          >
            Remove
          </button>
        )}
      </div>
      <div className="tiny muted center">Only your friends can see it. It is end-to-end encrypted.</div>
      <input ref={input} type="file" accept="image/*" hidden onChange={onPick} />
      {picked && (
        <AvatarCropper
          file={picked}
          onCancel={() => setPicked(null)}
          onSave={async (crop) => {
            await getController().setAvatar(await makeAvatar(picked, crop));
            setPicked(null);
          }}
        />
      )}
    </div>
  );
}

function NamePanel({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await getController().updateProfile({ displayName: name.trim() });
      onClose();
    } catch {
      setError('Could not save. Are you connected?');
    }
  };
  return (
    <Sheet title="Display name" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
        {error && <span className="error-text">{error}</span>}
        <button className="btn" disabled={!name.trim()}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function PasswordPanel({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const ok = await changePassword(current, next);
    setBusy(false);
    if (ok) onClose();
    else setError('Current password is incorrect.');
  };
  return (
    <Sheet title="Change password" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <input className="input" type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-label="Current password" />
        <input className="input" type="password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
        <input className="input" type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-label="Confirm new password" />
        {confirm && next !== confirm && <span className="error-text">Passwords do not match.</span>}
        {error && <span className="error-text">{error}</span>}
        <button className="btn" disabled={busy || !current || next.length < 8 || next !== confirm}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </Sheet>
  );
}

function BackupPanel({ onClose }: { onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [media, setMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const blob = await exportBackup(getController(), pass, media);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tasks-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Encrypted backup" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          The file is encrypted with a separate backup passphrase. It can only be restored on this same web address.
        </p>
        <input className="input" type="password" placeholder="Backup passphrase (8+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Backup passphrase" />
        <input className="input" type="password" placeholder="Confirm passphrase" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm passphrase" />
        <label className="row small">
          <input type="checkbox" checked={media} onChange={(e) => setMedia(e.target.checked)} /> Include photos, videos and voice
          notes (larger file)
        </label>
        <button className="btn" disabled={busy || pass.length < 8 || pass !== confirm}>
          {busy ? 'Encrypting…' : 'Export'}
        </button>
      </form>
    </Sheet>
  );
}

function WipePanel({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Wipe all data" onClose={onClose}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          This permanently deletes every conversation, contact, key and cached file on this device and removes your
          account from the server. It cannot be undone.
        </p>
        <label className="field">
          Type WIPE to confirm
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} autoCapitalize="characters" />
        </label>
        <button
          className="btn danger"
          disabled={busy || text !== 'WIPE'}
          onClick={() => {
            setBusy(true);
            void wipeAll();
          }}
        >
          {busy ? 'Wiping…' : 'Wipe everything'}
        </button>
      </div>
    </Sheet>
  );
}

/** Spec F9: an explicit "Enable notifications" button (iOS requires a direct tap). Status is shown inline. */
function NotificationsRow() {
  const enabled = useChat((s) => s.settings.notifications);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const ctrl = getController();
  const unavailable = pushUnavailableReason(ctrl.config.vapid_public_key ?? 'pending');

  const run = (fn: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(null);
    // No await before fn(): the permission prompt must start inside the tap handler.
    fn()
      .then((text) => text && setStatus({ text, error: false }))
      .catch((e: unknown) => setStatus({ text: e instanceof Error ? e.message : 'Something went wrong.', error: true }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div className="row">
        <div className="grow">
          Notifications
          <div className="tiny muted">Shown as “You have a task pending.”</div>
        </div>
        <span className="small muted">{enabled ? 'On' : 'Off'}</span>
      </div>
      {unavailable ? (
        <div className="small muted">{unavailable}</div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {enabled ? (
            <>
              <button className="btn small secondary" disabled={busy} onClick={() => run(sendTestPush)}>
                Send test notification
              </button>
              <button className="btn small secondary" disabled={busy} onClick={() => run(() => enablePush(ctrl).then(() => 'Re-registered this device.'))}>
                Re-register
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => run(() => disablePush(ctrl).then(() => 'Notifications turned off.'))}>
                Turn off
              </button>
            </>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => run(() => enablePush(ctrl).then(() => 'Notifications enabled. Tap “Send test notification” to check.'))}>
              {busy ? 'Enabling…' : 'Enable notifications'}
            </button>
          )}
        </div>
      )}
      {status && (
        <div className={status.error ? 'error-text' : 'small'} role={status.error ? 'alert' : 'status'}>
          {status.text}
        </div>
      )}
    </div>
  );
}
