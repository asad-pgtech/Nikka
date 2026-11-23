import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, Sheet, TopBar } from '@/components/ui';
import { cleanNickname, contactName, NICKNAME_MAX, QUICK_REACTIONS, type ChatMessage } from '@/domain/types';
import { formatCode } from '@/lib/crypto/code';
import { safetyNumber } from '@/lib/crypto/message';
import { b64encode } from '@/lib/encoding';
import { uploadAndDispatch } from '@/services/media';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { formatDay, formatLastSeen } from './format';

export function Conversation({ peer }: { peer: string }) {
  const contact = useChat((s) => s.contacts[peer]);
  const messages = useChat((s) => s.messages[peer]);
  const typing = useChat((s) => Boolean(s.typing[peer]));
  const online = useChat((s) => s.presence.some((p) => p.code === peer));
  const friend = useChat((s) => s.friends.find((f) => f.code === peer));
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const ctrl = getController();

  const byId = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);

  // Keep pinned to the bottom when new messages arrive.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, typing]);

  // Send read receipts while the conversation is visible.
  useEffect(() => {
    if (document.visibilityState === 'visible') void ctrl.markRead(peer);
  }, [messages?.length, peer, ctrl]);

  if (!contact) return null;
  const blocked = friend?.status === 'blocked';
  const canSend = friend?.status === 'accepted';
  const lastSeen = friend?.status === 'accepted' ? friend.last_seen : null;
  const status = typing ? 'typing…' : online ? 'online' : lastSeen ? formatLastSeen(lastSeen) : '';
  const name = contactName(contact);

  const retry = (m: ChatMessage) => {
    if (m.kind === 'media') void uploadAndDispatch(ctrl, { ...m, status: 'sending' }).catch(() => undefined);
    else void ctrl.retry(m);
  };

  let lastDay = '';
  return (
    <div className="screen">
      <TopBar
        onBack={() => ctrl.closeConversation()}
        title={
          <button
            onClick={() => setShowInfo(true)}
            className="row"
            style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', width: '100%', color: 'inherit', font: 'inherit' }}
            aria-label={`Contact info for ${name}`}
          >
            <Avatar name={name} src={contact.avatar} small />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{name}</div>
              <div className="tiny muted" style={{ fontWeight: 400, minHeight: '1em' }}>
                {status}
              </div>
            </div>
          </button>
        }
      />
      <div className="messages" ref={listRef} role="log" aria-live="polite">
        {messages === undefined && <p className="muted center">Loading…</p>}
        {(messages ?? []).map((m) => {
          const day = formatDay(m.ts);
          const sep = day !== lastDay ? <div className="day-sep">{day}</div> : null;
          lastDay = day;
          return (
            <div key={m.id}>
              {sep}
              <MessageBubble
                msg={m}
                replied={m.replyTo ? byId.get(m.replyTo) : undefined}
                onActions={() => setActionsFor(m)}
                onReply={canSend ? () => setReplyTo(m) : undefined}
                onRetry={() => retry(m)}
              />
            </div>
          );
        })}
      </div>
      <div className="typing" aria-hidden="true">
        {typing ? `${name} is typing…` : ''}
      </div>
      {canSend ? (
        <Composer peer={peer} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
      ) : (
        <div className="composer center muted small" style={{ justifyContent: 'center', padding: 16 }}>
          {blocked ? 'You blocked this contact.' : 'You can no longer message this contact.'}
        </div>
      )}

      {actionsFor && (
        <Sheet onClose={() => setActionsFor(null)}>
          {!actionsFor.deleted && canSend && actionsFor.status !== 'failed' && (
            <div className="reaction-picker" role="group" aria-label="React">
              {QUICK_REACTIONS.map((emoji) => {
                const mine = actionsFor.reactions?.me?.emoji === emoji;
                return (
                  <button
                    key={emoji}
                    className={mine ? 'selected' : undefined}
                    aria-pressed={mine}
                    aria-label={mine ? `Remove ${emoji} reaction` : `React ${emoji}`}
                    onClick={() => {
                      void ctrl.react(peer, actionsFor.id, mine ? null : emoji);
                      setActionsFor(null);
                    }}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
          {!actionsFor.deleted && canSend && (
            <button
              className="menu-item"
              onClick={() => {
                setReplyTo(actionsFor);
                setActionsFor(null);
              }}
            >
              Reply
            </button>
          )}
          {actionsFor.body && (
            <button
              className="menu-item"
              onClick={() => {
                void navigator.clipboard?.writeText(actionsFor.body ?? '');
                setActionsFor(null);
              }}
            >
              Copy
            </button>
          )}
          <button
            className="menu-item danger"
            onClick={() => {
              void ctrl.deleteForMe(peer, actionsFor.id);
              setActionsFor(null);
            }}
          >
            Delete for me
          </button>
          {actionsFor.dir === 'out' && !actionsFor.deleted && actionsFor.status !== 'failed' && canSend && (
            <button
              className="menu-item danger"
              onClick={() => {
                void ctrl.deleteForEveryone(peer, actionsFor.id);
                setActionsFor(null);
              }}
            >
              Delete for everyone
            </button>
          )}
          <button className="menu-item" onClick={() => setActionsFor(null)}>
            Cancel
          </button>
        </Sheet>
      )}

      {showInfo && <ContactInfo peer={peer} onClose={() => setShowInfo(false)} blocked={blocked} />}
    </div>
  );
}

function ContactInfo({ peer, onClose, blocked }: { peer: string; onClose: () => void; blocked: boolean }) {
  const contact = useChat((s) => s.contacts[peer]);
  const [safety, setSafety] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<null | 'them' | 'me'>(null);
  const canEdit = useChat((s) => s.friends.some((f) => f.code === peer && f.status === 'accepted'));
  const ctrl = getController();
  const name = contactName(contact);

  useEffect(() => {
    void safetyNumber(b64encode(ctrl.identity.signPub), contact.identityKey).then(setSafety);
  }, [ctrl, contact.identityKey]);

  return (
    <Sheet title={name} onClose={onClose}>
      <div className="stack">
        {contact.avatar && (
          <div className="avatar-edit">
            <Avatar name={name} src={contact.avatar} large />
          </div>
        )}
        {contact.nickname && <div className="tiny muted">Name: {contact.displayName}</div>}
        <div>
          <div className="tiny muted">Nicknames · both of you see them</div>
          <div className="list" style={{ marginTop: 6 }}>
            <button className="list-item" disabled={!canEdit} onClick={() => setEditing('them')}>
              <span className="grow ellipsis">{contact.displayName}</span>
              <span className="muted ellipsis">{contact.nickname ?? 'Set nickname'}</span>
            </button>
            <button className="list-item" disabled={!canEdit} onClick={() => setEditing('me')}>
              <span className="grow">You</span>
              <span className="muted ellipsis">{contact.myNickname ?? 'Set nickname'}</span>
            </button>
          </div>
        </div>
        <div>
          <div className="tiny muted">Code</div>
          <div className="mono">{formatCode(contact.code)}</div>
        </div>
        <div>
          <div className="row tiny muted">
            <Icon name="shield" size={14} /> Safety number — compare in person; it matches on both phones.
          </div>
          <div className="mono small" style={{ lineHeight: 1.6 }}>
            {safety}
          </div>
        </div>
        {blocked ? (
          <button className="btn secondary" onClick={() => void ctrl.friendAction(peer, 'unblock').then(onClose)}>
            Unblock
          </button>
        ) : (
          <button className="btn danger" onClick={() => void ctrl.friendAction(peer, 'block').then(onClose)}>
            Block
          </button>
        )}
        {confirmDelete ? (
          <button
            className="btn danger"
            onClick={() => {
              void ctrl.deleteConversation(peer);
              onClose();
            }}
          >
            Tap again to delete all messages
          </button>
        ) : (
          <button className="btn secondary" onClick={() => setConfirmDelete(true)}>
            Delete conversation history
          </button>
        )}
      </div>
      {editing && (
        <NicknameEditor
          title={editing === 'me' ? 'Your nickname' : `Nickname for ${contact.displayName}`}
          initial={(editing === 'me' ? contact.myNickname : contact.nickname) ?? ''}
          onClose={() => setEditing(null)}
          onSave={(value) => ctrl.setNickname(peer, editing, value)}
        />
      )}
    </Sheet>
  );
}

function NicknameEditor({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (v: string | null) => {
    setBusy(true);
    setError('');
    try {
      await onSave(v);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  const valid = cleanNickname(value) !== null && value.trim() !== initial;
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(value);
        }}
      >
        <input
          className="input"
          value={value}
          maxLength={NICKNAME_MAX}
          autoFocus
          placeholder="Nickname"
          aria-label="Nickname"
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="tiny muted">Visible to both of you in this chat.</div>
        {error && <span className="error-text">{error}</span>}
        <button className="btn" disabled={busy || !valid}>
          Save
        </button>
        {initial && (
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void save(null)}>
            Remove nickname
          </button>
        )}
      </form>
    </Sheet>
  );
}
