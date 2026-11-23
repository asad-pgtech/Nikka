import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Avatar, Sheet, TopBar } from '@/components/ui';
import type { ChatMessage } from '@/domain/types';
import { formatCode } from '@/lib/crypto/code';
import { safetyNumber } from '@/lib/crypto/message';
import { b64encode } from '@/lib/encoding';
import { uploadAndDispatch } from '@/services/media';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { formatDay } from './format';

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
  const status = typing ? 'typing…' : online ? 'online' : '';

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
            aria-label={`Contact info for ${contact.displayName}`}
          >
            <Avatar name={contact.displayName} src={contact.avatar} small />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{contact.displayName}</div>
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
        {typing ? `${contact.displayName} is typing…` : ''}
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
  const ctrl = getController();

  useEffect(() => {
    void safetyNumber(b64encode(ctrl.identity.signPub), contact.identityKey).then(setSafety);
  }, [ctrl, contact.identityKey]);

  return (
    <Sheet title={contact.displayName} onClose={onClose}>
      <div className="stack">
        {contact.avatar && (
          <div className="avatar-edit">
            <Avatar name={contact.displayName} src={contact.avatar} large />
          </div>
        )}
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
    </Sheet>
  );
}
