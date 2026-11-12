/**
 * Encrypted, chunked, resumable media transfer (spec 6.5, F8).
 * Upload state (blob id + file key) is persisted in the vault so a failed upload can resume.
 */
import type { ChatMessage } from '@/domain/types';
import { Api } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/http';
import { chunkCount, decryptChunk, encryptChunk, importFileKey, newFileKey, type FileKey } from '@/lib/crypto/media';
import type { MediaDescriptor } from '@/lib/crypto/message';
import { TAG_BYTES } from '@/lib/crypto/aead';
import { b64decode, b64encode, concatBytes } from '@/lib/encoding';
import { classifyFile, imageThumbnail, videoPoster } from '@/lib/media/thumbnails';
import { useChat } from '@/state/chat';
import { ChatController } from './controller';

interface UploadState {
  msgId: string;
  peer: string;
  /** Set once the server blob exists; absent while the upload has not started. */
  blobId?: string;
  key?: string;
  baseIv?: string;
}

const MAX_ATTEMPTS = 5;

async function withRetry<T>(fn: () => Promise<T>, isStopped: () => boolean): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (isStopped()) throw new Error('session closed');
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
    }
  }
  throw lastErr;
}

export interface PreparedMedia {
  blob: Blob;
  descriptor: Omit<MediaDescriptor, 'blobId' | 'key' | 'baseIv' | 'chunkBytes' | 'chunks'>;
}

/** Build the descriptor metadata (kind, preview, dimensions) before upload. */
export async function prepareFile(file: File | Blob, overrides: Partial<PreparedMedia['descriptor']> = {}): Promise<PreparedMedia> {
  const asFile = file instanceof File ? file : new File([file], 'file', { type: file.type });
  const kind = overrides.kind ?? classifyFile(asFile);
  let extra: Partial<MediaDescriptor> = {};
  try {
    if (kind === 'image' || kind === 'gif') extra = await imageThumbnail(asFile);
    else if (kind === 'video') extra = await videoPoster(asFile);
  } catch {
    /* preview is optional */
  }
  return {
    blob: file,
    descriptor: {
      kind,
      mime: asFile.type || 'application/octet-stream',
      name: file instanceof File ? file.name.slice(0, 120) : undefined,
      size: file.size,
      ...extra,
      ...overrides,
    },
  };
}

export async function sendMedia(
  ctrl: ChatController,
  peer: string,
  prepared: PreparedMedia,
  caption?: string,
  replyTo?: string,
): Promise<void> {
  const { blob, descriptor } = prepared;
  if (blob.size > ctrl.config.max_file_bytes) throw new Error('File is too large');

  const data = new Uint8Array(await blob.arrayBuffer());
  const placeholderId = `local-${crypto.randomUUID()}`;
  // Cache plaintext locally (encrypted under the vault) so the sender can view it and retries can resume.
  await ctrl.store.putMedia(placeholderId, data);
  const msg = await ctrl.createOutgoing(peer, {
    kind: 'media',
    caption: caption?.trim() || undefined,
    replyTo,
    media: {
      ...descriptor,
      blobId: placeholderId,
      key: '',
      baseIv: '',
      chunkBytes: ctrl.config.chunk_bytes,
      chunks: chunkCount(data.length, ctrl.config.chunk_bytes),
    },
  });
  const uploads = (await ctrl.store.getKv<UploadState[]>('uploads')) ?? [];
  await ctrl.store.setKv('uploads', [...uploads, { msgId: msg.id, peer }]);
  await uploadAndDispatch(ctrl, msg);
}

/** Upload (or resume) the media of an outgoing message, then send its envelope. */
export async function uploadAndDispatch(ctrl: ChatController, msg: ChatMessage): Promise<void> {
  const chat = useChat.getState();
  const media = msg.media;
  if (!media) return;
  const isStopped = () => ctrl.isStopped;
  const uploads = (await ctrl.store.getKv<UploadState[]>('uploads')) ?? [];
  const found = uploads.find((u) => u.msgId === msg.id);
  let state = found?.blobId && found.key && found.baseIv ? (found as Required<UploadState>) : undefined;
  const localId = media.blobId;

  try {
    const data = await ctrl.store.getMedia(localId);
    if (!data) throw new Error('local media missing');
    const chunkBytes = ctrl.config.chunk_bytes;
    const count = chunkCount(data.length, chunkBytes);
    const ctSize = data.length + count * TAG_BYTES;

    let fk: FileKey;
    let received = new Set<number>();
    if (state) {
      fk = await importFileKey(b64decode(state.key), b64decode(state.baseIv));
      try {
        const status = await Api.blobStatus(state.blobId);
        received = new Set(status.received);
      } catch {
        state = undefined; // blob gone (expired); start over
      }
    }
    if (!state) {
      fk = await newFileKey();
      const { blob_id } = await withRetry(() => Api.createBlob(msg.peer, ctSize, count), isStopped);
      state = { msgId: msg.id, peer: msg.peer, blobId: blob_id, key: b64encode(fk.raw), baseIv: b64encode(fk.baseIv) };
      await ctrl.store.setKv('uploads', [...uploads.filter((u) => u.msgId !== msg.id), state]);
    }
    const blobId = state.blobId;

    for (let i = 0; i < count; i++) {
      if (!received.has(i)) {
        const ct = await encryptChunk(fk!, blobId, i, count, data.subarray(i * chunkBytes, (i + 1) * chunkBytes));
        await withRetry(() => Api.putChunk(blobId, i, ct), isStopped);
      }
      chat.setTransfer(msg.id, { done: i + 1, total: count });
      window.dispatchEvent(new Event('app-activity'));
    }
    await withRetry(() => Api.completeBlob(blobId), isStopped);

    // Re-key the local cache from the placeholder to the real blob id.
    if (localId !== blobId) {
      await ctrl.store.putMedia(blobId, data);
      await ctrl.store.deleteMedia(localId);
    }
    const sent: ChatMessage = {
      ...msg,
      status: 'sending',
      media: { ...media, blobId, key: state.key, baseIv: state.baseIv, chunkBytes, chunks: count },
    };
    const remaining = ((await ctrl.store.getKv<UploadState[]>('uploads')) ?? []).filter((u) => u.msgId !== msg.id);
    await ctrl.store.setKv('uploads', remaining);
    chat.setTransfer(msg.id, null);
    await ctrl.dispatch(sent);
  } catch (e) {
    if (ctrl.isStopped) return;
    chat.setTransfer(msg.id, { done: 0, total: 1, error: true });
    await ctrl.markFailed(msg);
    throw e;
  }
}

const inflight = new Map<string, Promise<void>>();

/** Download, decrypt, cache (under the vault key) and acknowledge an incoming blob. */
export function downloadMedia(ctrl: ChatController, msg: ChatMessage): Promise<void> {
  const media = msg.media;
  if (!media) return Promise.resolve();
  const existing = inflight.get(media.blobId);
  if (existing) return existing;
  const p = (async () => {
    if (await ctrl.store.hasMedia(media.blobId)) return;
    const chat = useChat.getState();
    const fk = await importFileKey(b64decode(media.key), b64decode(media.baseIv));
    const parts: Uint8Array[] = [];
    try {
      for (let i = 0; i < media.chunks; i++) {
        const ct = await withRetry(() => Api.getChunk(media.blobId, i), () => ctrl.isStopped);
        parts.push(await decryptChunk(fk, media.blobId, i, media.chunks, ct));
        chat.setTransfer(msg.id, { done: i + 1, total: media.chunks });
        window.dispatchEvent(new Event('app-activity'));
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        const updated = { ...msg, mediaExpired: true };
        await ctrl.store.putMessage(updated);
        chat.upsertMessage(updated);
        chat.setTransfer(msg.id, null);
        return;
      }
      chat.setTransfer(msg.id, { done: 0, total: 1, error: true });
      throw e;
    }
    await ctrl.store.putMedia(media.blobId, concatBytes(...parts));
    chat.setTransfer(msg.id, null);
    if (msg.dir === 'in') void Api.blobDownloaded(media.blobId).catch(() => undefined);
    // Nudge subscribers so the bubble swaps the thumbnail for the real media.
    chat.upsertMessage({ ...msg });
  })().finally(() => inflight.delete(media.blobId));
  inflight.set(media.blobId, p);
  return p;
}

/** Decrypt cached media into an object URL (revoked on lock). */
export async function mediaUrl(ctrl: ChatController, media: MediaDescriptor): Promise<string | null> {
  const chat = useChat.getState();
  const cached = chat.mediaUrls[media.blobId];
  if (cached) return cached;
  const data = await ctrl.store.getMedia(media.blobId);
  if (!data) return null;
  const url = URL.createObjectURL(new Blob([data], { type: media.mime }));
  chat.setMediaUrl(media.blobId, url);
  return url;
}

/** On unlock: any upload interrupted by a lock is marked failed so the user can retry. */
export async function markInterruptedUploads(ctrl: ChatController): Promise<void> {
  const uploads = (await ctrl.store.getKv<UploadState[]>('uploads')) ?? [];
  for (const u of uploads) {
    const msg = await ctrl.store.getMessage(u.peer, u.msgId);
    if (msg && msg.status === 'sending') await ctrl.markFailed(msg);
  }
}

ChatController.autoDownload = (ctrl, msg) => void downloadMedia(ctrl, msg).catch(() => undefined);
