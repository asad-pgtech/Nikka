/**
 * Decrypted UI state for the unlocked area. `reset()` is called on lock so no plaintext remains in
 * React state (spec F3).
 */
import { create } from 'zustand';
import type { ChatMessage, Contact, Friend, LocalSettings, PresenceUser } from '@/domain/types';
import type { ConnectionState } from '@/lib/api/socket';

export interface TransferProgress {
  done: number;
  total: number;
  error?: boolean;
}

export const DEFAULT_SETTINGS: LocalSettings = { readReceipts: true, autoLockSeconds: 120, notifications: false };

interface ChatState {
  me: {
    code: string;
    displayName: string;
    /** undefined until the server has answered; null when the user has not picked one yet. */
    username?: string | null;
    discoverable: boolean;
    showLastSeen: boolean;
    avatar?: string;
  } | null;
  settings: LocalSettings;
  connection: ConnectionState;
  contacts: Record<string, Contact>;
  friends: Friend[];
  presence: PresenceUser[];
  typing: Record<string, number>;
  /** Messages of loaded conversations, keyed by peer code. */
  messages: Record<string, ChatMessage[]>;
  activePeer: string | null;
  transfers: Record<string, TransferProgress>;
  /** blobId -> object URL for decrypted media (revoked on lock). */
  mediaUrls: Record<string, string>;

  set: (partial: Partial<ChatState>) => void;
  upsertContact: (c: Contact) => void;
  removeContact: (code: string) => void;
  setConversation: (peer: string, msgs: ChatMessage[]) => void;
  upsertMessage: (m: ChatMessage) => void;
  removeMessage: (peer: string, id: string) => void;
  setTyping: (peer: string, active: boolean) => void;
  setTransfer: (id: string, p: TransferProgress | null) => void;
  setMediaUrl: (blobId: string, url: string) => void;
  reset: () => void;
}

const initial = {
  me: null,
  settings: DEFAULT_SETTINGS,
  connection: 'offline' as ConnectionState,
  contacts: {},
  friends: [],
  presence: [],
  typing: {},
  messages: {},
  activePeer: null,
  transfers: {},
  mediaUrls: {},
};

export const useChat = create<ChatState>((set, get) => ({
  ...initial,
  set: (partial) => set(partial),
  upsertContact: (c) => set((s) => ({ contacts: { ...s.contacts, [c.code]: c } })),
  removeContact: (code) =>
    set((s) => {
      const contacts = { ...s.contacts };
      delete contacts[code];
      const messages = { ...s.messages };
      delete messages[code];
      return { contacts, messages };
    }),
  setConversation: (peer, msgs) => set((s) => ({ messages: { ...s.messages, [peer]: msgs } })),
  upsertMessage: (m) =>
    set((s) => {
      const list = s.messages[m.peer];
      if (!list) return {};
      const idx = list.findIndex((x) => x.id === m.id);
      const next = idx >= 0 ? list.map((x, i) => (i === idx ? m : x)) : [...list, m].sort((a, b) => a.ts - b.ts);
      return { messages: { ...s.messages, [m.peer]: next } };
    }),
  removeMessage: (peer, id) =>
    set((s) => {
      const list = s.messages[peer];
      return list ? { messages: { ...s.messages, [peer]: list.filter((m) => m.id !== id) } } : {};
    }),
  setTyping: (peer, active) =>
    set((s) => {
      const typing = { ...s.typing };
      if (active) typing[peer] = Date.now();
      else delete typing[peer];
      return { typing };
    }),
  setTransfer: (id, p) =>
    set((s) => {
      const transfers = { ...s.transfers };
      if (p) transfers[id] = p;
      else delete transfers[id];
      return { transfers };
    }),
  setMediaUrl: (blobId, url) => set((s) => ({ mediaUrls: { ...s.mediaUrls, [blobId]: url } })),
  reset: () => {
    Object.values(get().mediaUrls).forEach((u) => URL.revokeObjectURL(u));
    set({ ...initial });
  },
}));
