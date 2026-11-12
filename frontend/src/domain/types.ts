/** Decrypted domain models. These only exist in memory while the vault is unlocked. */
import type { MediaDescriptor } from '@/lib/crypto/message';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export interface ChatMessage {
  id: string;
  peer: string;
  dir: 'in' | 'out';
  ts: number;
  kind: 'text' | 'media';
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
}

export interface Contact {
  code: string;
  displayName: string;
  identityKey: string;
  agreementKey: string;
  agreementKeySig: string;
  addedAt: number;
  lastTs?: number;
  lastPreview?: string;
  unread?: number;
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
