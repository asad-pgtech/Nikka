/** People on the network (F4), find by code or username (F5) and friend requests (F6). */
import { useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui';
import type { Friend, PublicUser } from '@/domain/types';
import { isValidUsername, normalizeUsername } from '@/domain/username';
import { Api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/http';
import { formatCode, normalizeCode } from '@/lib/crypto/code';
import { verifyPeerKeys } from '@/lib/crypto/identity';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';

const REQUEST_ERRORS: Record<string, string> = {
  not_found: 'No user with that code or username.',
  already_friends: 'You are already connected.',
  already_pending: 'Request already sent.',
  incoming_pending: 'They already sent you a request — accept it below.',
  cooldown: 'Please wait before asking this person again.',
  daily_cap: 'You have sent too many requests today.',
  self: 'That is you.',
  rate_limited: 'Too many lookups. Try again in a minute.',
};

const errorText = (e: unknown) =>
  e instanceof ApiError ? (REQUEST_ERRORS[e.code] ?? e.message) : 'Something went wrong. Check your connection.';

export function PeopleScreen() {
  const me = useChat((s) => s.me);
  const friends = useChat((s) => s.friends);
  const presence = useChat((s) => s.presence);
  const contacts = useChat((s) => s.contacts);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PublicUser | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const ctrl = getController();

  const incoming = friends.filter((f) => f.status === 'pending' && f.direction === 'incoming');
  const outgoing = friends.filter((f) => f.direction === 'outgoing' && (f.status === 'pending' || f.status === 'declined'));
  const relation = (code: string): Friend | undefined => friends.find((f) => f.code === code);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setFound(null);
    setMessage('');
    const asUsername = query.trim().startsWith('@');
    const code = asUsername ? null : normalizeCode(query);
    const username = normalizeUsername(query);
    if (!code && !isValidUsername(username)) {
      setMessage('Enter a username or a code like XXXX-XXXX-XXXX.');
      return;
    }
    if (code === me?.code || username === me?.username) {
      setMessage(REQUEST_ERRORS.self);
      return;
    }
    setBusy(true);
    try {
      const user = await Api.lookup(code ?? `@${username}`);
      const ok = await verifyPeerKeys(user.code, {
        identityKey: user.identity_key,
        agreementKey: user.agreement_key,
        agreementKeySig: user.agreement_key_sig,
      });
      const matches = user.code === code || (!!user.username && user.username === username);
      if (!ok || !matches) setMessage('That user’s keys could not be verified.');
      else setFound(user);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<void>, success?: string) => {
    setMessage('');
    setBusy(true);
    try {
      await fn();
      if (success) setMessage(success);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const actionFor = (code: string) => {
    const rel = relation(code);
    if (contacts[code] || rel?.status === 'accepted')
      return (
        <button className="btn small secondary" onClick={() => void ctrl.openConversation(code)}>
          Chat
        </button>
      );
    if (rel?.status === 'pending' && rel.direction === 'outgoing') return <span className="small muted">Requested</span>;
    if (rel?.status === 'pending' && rel.direction === 'incoming')
      return (
        <button className="btn small" disabled={busy} onClick={() => void run(() => ctrl.acceptFriend(code))}>
          Accept
        </button>
      );
    return (
      <button className="btn small" disabled={busy} onClick={() => void run(() => ctrl.sendFriendRequest(code), 'Request sent.')}>
        Add
      </button>
    );
  };

  return (
    <>
      <header className="topbar">
        <h1>People</h1>
      </header>
      <div className="scroll">
        <div className="content">
          <form className="row" onSubmit={search}>
            <input
              className="input"
              placeholder="Username or XXXX-XXXX-XXXX"
              aria-label="Find by username or code"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={24}
            />
            <button className="btn" type="submit" disabled={busy || !query.trim()}>
              Find
            </button>
          </form>
          {message && (
            <p className="small muted" role="status" style={{ margin: '8px 4px' }}>
              {message}
            </p>
          )}
          {found && (
            <div className="list" style={{ marginTop: 10 }}>
              <div className="list-item">
                <Avatar src={contacts[found.code]?.avatar} name={contacts[found.code]?.nickname || found.display_name} />
                <div className="grow">
                  <strong className="ellipsis">{contacts[found.code]?.nickname || found.display_name}</strong>
                  <div className="tiny muted mono">
                    {found.username ? `@${found.username} · ` : ''}
                    {formatCode(found.code)}
                  </div>
                </div>
                {actionFor(found.code)}
              </div>
            </div>
          )}

          {incoming.length > 0 && (
            <>
              <div className="section-title">Requests</div>
              <div className="list">
                {incoming.map((f) => (
                  <div className="list-item" key={f.code} style={{ flexWrap: 'wrap' }}>
                    <Avatar src={contacts[f.code]?.avatar} name={contacts[f.code]?.nickname || f.display_name} />
                    <div className="grow">
                      <strong className="ellipsis">{contacts[f.code]?.nickname || f.display_name}</strong>
                      <div className="tiny muted mono">{formatCode(f.code)}</div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn small" disabled={busy} onClick={() => void run(() => ctrl.acceptFriend(f.code))}>
                        Accept
                      </button>
                      <button className="btn small secondary" disabled={busy} onClick={() => void run(() => ctrl.friendAction(f.code, 'decline'))}>
                        Decline
                      </button>
                      <button className="btn small ghost" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => void run(() => ctrl.friendAction(f.code, 'block'))}>
                        Block
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {outgoing.length > 0 && (
            <>
              <div className="section-title">Sent requests</div>
              <div className="list">
                {outgoing.map((f) => (
                  <div className="list-item" key={f.code}>
                    <Avatar src={contacts[f.code]?.avatar} name={contacts[f.code]?.nickname || f.display_name} />
                    <div className="grow">
                      <strong className="ellipsis">{contacts[f.code]?.nickname || f.display_name}</strong>
                      <div className="tiny muted">{f.status === 'declined' ? 'Declined' : 'Waiting for reply'}</div>
                    </div>
                    {f.status === 'pending' && (
                      <button className="btn small secondary" disabled={busy} onClick={() => void run(() => ctrl.friendAction(f.code, 'cancel'))}>
                        Cancel
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="section-title">On this network</div>
          {presence.length === 0 ? (
            <p className="small muted" style={{ margin: '0 4px' }}>
              Nobody else is online right now.
            </p>
          ) : (
            <div className="list">
              {presence.map((p) => (
                <div className="list-item" key={p.code}>
                  <Avatar src={contacts[p.code]?.avatar} name={contacts[p.code]?.nickname || p.display_name} online />
                  <div className="grow">
                    <strong className="ellipsis">{contacts[p.code]?.nickname || p.display_name}</strong>
                    <div className="tiny muted mono">{formatCode(p.code)}</div>
                  </div>
                  {actionFor(p.code)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
