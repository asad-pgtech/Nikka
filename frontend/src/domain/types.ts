/** Decrypted domain models. These only exist in memory while the vault is unlocked. */
import type { MediaDescriptor } from '@/lib/crypto/message';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export interface ChatMessage {
  id: string;
  peer: string;
  dir: 'in' | 'out';
  ts: number;
  /** `notice`: local system line (e.g. nickname changes), never sent as-is. */
  kind: 'text' | 'media' | 'notice';
  body?: string;
  media?: MediaDescriptor;
  caption?: string;
  replyTo?: string;
  status: MessageStatus;
  deleted?: boolean;
  /** Media no longer available on the server (TTL expired or already fetched elsewhere). */
  mediaExpired?: boolean;
  /** Incoming: whether we've sent a read receipt. */
  readSent?: boolean;
  /** Incoming: opaque push reference, used to route a notification tap to this conversation. */
  ref?: string;
  /** Emoji reactions, one per side of the chat. `emoji: null` records a removal (kept for its `ts`). */
  reactions?: { me?: Reaction; peer?: Reaction };
}

export interface Reaction {
  emoji: string | null;
  /** Highest `ts` wins, so stale or replayed updates are ignored. */
  ts: number;
}

/** Quick reactions offered in the message menu. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** A reaction must be a short emoji-like string: no letters, digits or control characters. */
export function cleanReaction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 32 || [...s].length > 8) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\p{L}\p{N}]/u.test(s)) return null;
  return s;
}

/** Reactions to show under a message, in order (theirs first). */
export function shownReactions(m: Pick<ChatMessage, 'reactions'>): { who: 'me' | 'peer'; emoji: string }[] {
  const out: { who: 'me' | 'peer'; emoji: string }[] = [];
  const peer = m.reactions?.peer?.emoji;
  const me = m.reactions?.me?.emoji;
  if (peer) out.push({ who: 'peer', emoji: peer });
  if (me) out.push({ who: 'me', emoji: me });
  return out;
}

export interface Contact {
  code: string;
  displayName: string;
  identityKey: string;
  agreementKey: string;
  agreementKeySig: string;
  addedAt: number;
  /** Profile picture (data: URL) received end-to-end encrypted from the contact. */
  avatar?: string;
  /** `ts` of the profile update that set `avatar`; older updates are ignored. */
  avatarTs?: number;
  lastTs?: number;
  lastPreview?: string;
  unread?: number;
  /** Nickname for this contact, shared by both sides of the chat. */
  nickname?: string;
  nicknameTs?: number;
  /** Nickname for me in this chat, shared by both sides. */
  myNickname?: string;
  myNicknameTs?: number;
}

export const NICKNAME_MAX = 40;

/** Name to show for a contact: the chat nickname if set, else their own display name. */
export function contactName(c: Pick<Contact, 'displayName' | 'nickname'>): string {
  return c.nickname || c.displayName;
}

/** Trim and drop control characters; null for empty or too-long names. */
export function cleanNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && [...name].length <= NICKNAME_MAX ? name : null;
}

export interface LocalSettings {
  readReceipts: boolean;
  autoLockSeconds: number;
  notifications: boolean;
}

export interface Friend {
  code: string;
  display_name: string;
  identity_key: string;
  agreement_key: string;
  agreement_key_sig: string;
  status: 'pending' | 'accepted' | 'declined' | 'blocked';
  direction: 'incoming' | 'outgoing';
  blocked_by_me: boolean;
  /** Null for block-only relationships (no request was ever made). */
  request_ts: number | null;
  request_sig: string | null;
  accept_ts: number | null;
  accept_sig: string | null;
  updated_at: number;
  /** Epoch ms the friend last went offline; null unless both sides share last seen. */
  last_seen?: number | null;
}

export interface PublicUser {
  code: string;
  display_name: string;
  identity_key: string;
  agreement_key: string;
  agreement_key_sig: string;
}

export interface PresenceUser {
  code: string;
  display_name: string;
  friend: boolean;
}

export interface QueueItem {
  qid: string;
  kind: 'msg' | 'delivered' | 'read';
  from: string;
  ts: number;
  msg_id?: string;
  msg_ids?: string[];
  payload?: string;
  ref?: string;
}

export interface ServerConfig {
  max_file_bytes: number;
  chunk_bytes: number;
  max_payload_bytes: number;
  autolock_default_seconds: number;
  media_ttl_days: number;
  vapid_public_key: string | null;
}
