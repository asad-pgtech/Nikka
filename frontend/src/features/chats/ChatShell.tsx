/** Unlocked area: tabs for chats, people and settings; a conversation takes over the screen. */
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { PeopleScreen } from '@/features/people/PeopleScreen';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { UsernameRequired } from '@/features/settings/UsernameForm';
import { useChat } from '@/state/chat';
import { ChatList } from './ChatList';
import { Conversation } from './Conversation';

type Tab = 'chats' | 'people' | 'settings';

export function ChatShell() {
  const [tab, setTab] = useState<Tab>('chats');
  const activePeer = useChat((s) => s.activePeer);
  const connection = useChat((s) => s.connection);
  const incoming = useChat((s) => s.friends.filter((f) => f.status === 'pending' && f.direction === 'incoming').length);

  if (activePeer)
    return (
      <>
        <Conversation peer={activePeer} />
        <UsernameRequired />
      </>
    );

  return (
    <div className="screen">
      {connection !== 'online' && (
        <div className="conn-bar" role="status" style={{ paddingTop: 'calc(var(--safe-top) + 4px)' }}>
          Connecting…
        </div>
      )}
      <div className="grow" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {tab === 'chats' && <ChatList onFindPeople={() => setTab('people')} />}
        {tab === 'people' && <PeopleScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </div>
      <nav className="tabbar" aria-label="Sections">
        <TabButton tab="chats" current={tab} onSelect={setTab} icon="chats" label="Chats" />
        <TabButton tab="people" current={tab} onSelect={setTab} icon="people" label="People" badge={incoming} />
        <TabButton tab="settings" current={tab} onSelect={setTab} icon="settings" label="Settings" />
      </nav>
      <UsernameRequired />
    </div>
  );
}

function TabButton({
  tab,
  current,
  onSelect,
  icon,
  label,
  badge,
}: {
  tab: Tab;
  current: Tab;
  onSelect: (t: Tab) => void;
  icon: 'chats' | 'people' | 'settings';
  label: string;
  badge?: number;
}) {
  return (
    <button aria-current={tab === current ? 'page' : undefined} onClick={() => onSelect(tab)}>
      <Icon name={icon} size={22} />
      {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );
}
