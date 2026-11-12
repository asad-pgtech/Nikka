/** Typed REST endpoints. Mirrors docs/PROTOCOL.md. */
import type { Friend, PublicUser, ServerConfig } from '@/domain/types';
import { api } from './http';

export const Api = {
  config: () => api<ServerConfig>('/config', { auth: false }),

  register: (body: {
    code: string;
    display_name: string;
    identity_key: string;
    agreement_key: string;
    agreement_key_sig: string;
    discoverable: boolean;
  }) => api<{ code: string }>('/register', { method: 'POST', body, auth: false }),

  challenge: (code: string) =>
    api<{ nonce: string; expires_at: number }>('/auth/challenge', { method: 'POST', body: { code }, auth: false }),

  session: (code: string, nonce: string, signature: string) =>
    api<{ token: string; expires_at: number }>('/auth/session', {
      method: 'POST',
      body: { code, nonce, signature },
      auth: false,
    }),

  me: () => api<{ code: string; display_name: string; discoverable: boolean }>('/me'),
  updateMe: (body: { display_name?: string; discoverable?: boolean }) =>
    api<{ code: string; display_name: string; discoverable: boolean }>('/me', { method: 'PATCH', body }),
  deleteMe: () => api('/me', { method: 'DELETE', expect: 'none' }),

  lookup: (code: string) => api<PublicUser>(`/users/${encodeURIComponent(code)}`),

  friends: () => api<{ friends: Friend[] }>('/friends'),
  requestFriend: (to: string, ts: number, signature: string) =>
    api('/friends/request', { method: 'POST', body: { to, ts, signature } }),
  acceptFriend: (code: string, ts: number, signature: string) =>
    api(`/friends/${code}/accept`, { method: 'POST', body: { ts, signature } }),
  friendAction: (code: string, action: 'decline' | 'cancel' | 'block' | 'unblock') =>
    api(`/friends/${code}/${action}`, { method: 'POST' }),

  createBlob: (to: string, size: number, chunk_count: number) =>
    api<{ blob_id: string; chunk_bytes: number }>('/media', { method: 'POST', body: { to, size, chunk_count } }),
  blobStatus: (blobId: string) =>
    api<{ blob_id: string; size: number; chunk_count: number; received: number[]; complete: boolean }>(
      `/media/${blobId}`,
    ),
  putChunk: (blobId: string, index: number, data: Uint8Array, signal?: AbortSignal) =>
    api(`/media/${blobId}/chunks/${index}`, { method: 'PUT', raw: data as BodyInit, expect: 'none', signal }),
  completeBlob: (blobId: string) => api(`/media/${blobId}/complete`, { method: 'POST', expect: 'none' }),
  getChunk: (blobId: string, index: number, signal?: AbortSignal) =>
    api<Uint8Array>(`/media/${blobId}/chunks/${index}`, { expect: 'bytes', signal }),
  blobDownloaded: (blobId: string) => api(`/media/${blobId}/downloaded`, { method: 'POST', expect: 'none' }),

  pushSubscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    api('/push/subscribe', { method: 'POST', body: { endpoint, keys }, expect: 'none' }),
  pushTest: () =>
    api<{ enabled: boolean; subscriptions: number; statuses: (number | null)[] }>('/push/test', { method: 'POST' }),
  pushUnsubscribe: (endpoint: string) =>
    api('/push/subscribe', { method: 'DELETE', body: { endpoint }, expect: 'none' }),
};
