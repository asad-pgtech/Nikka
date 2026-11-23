import { useMemo } from 'react';
import { Avatar } from '@/components/ui';
import { contactName } from '@/domain/types';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';
import { formatListTime } from './format';

export function ChatList({ onFindPeople }: { onFindPeople: () => void }) {
  const contacts = useChat((s) => s.contacts);
  const friends = useChat((s) => s.friends);
  const presence = useChat((s) => s.presence);
  const typing = useChat((s) => s.typing);

  const online = useMemo(() => new Set(presence.map((p) => p.code)), [presence]);
  const blocked = useMemo(
    () => new Set(friends.filter((f) => f.status === 'blocked').map((f) => f.code)),
    [friends],
  );
  const sorted = useMemo(
    () => Object.values(contacts).sort((a, b) => (b.lastTs ?? b.addedAt) - (a.lastTs ?? a.addedAt)),
    [contacts],
  );

  return (
    <>
      <header className="topbar">
        <h1>Chats</h1>
      </header>
      <div className="scroll">
        <div className="content">
          {sorted.length === 0 ? (
            <div className="center stack" style={{ paddingTop: 60 }}>
              <p className="muted">No conversations yet.</p>
              <button className="btn" onClick={onFindPeople}>
                Find people
              </button>
            </div>
          ) : (
            <div className="list">
              {sorted.map((c) => (
                <button key={c.code} className="list-item" onClick={() => void getController().openConversation(c.code)}>
                  <Avatar name={contactName(c)} src={c.avatar} online={online.has(c.code)} />
                  <div className="grow">
                    <div className="row">
                      <strong className="grow ellipsis">{contactName(c)}</strong>
                      {c.lastTs && <span className="tiny muted">{formatListTime(c.lastTs)}</span>}
                    </div>
                    <div className="row">
                      <span className="small muted grow ellipsis">
                        {blocked.has(c.code) ? 'Blocked' : typing[c.code] ? 'typing…' : (c.lastPreview ?? 'Say hello')}
                      </span>
                      {c.unread ? <span className="badge">{c.unread}</span> : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
