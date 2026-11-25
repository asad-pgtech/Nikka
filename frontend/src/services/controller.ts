/**
 * ChatController: the unlocked session. Owns the identity keys, the encrypted store, the socket and
 * the per-friend keys. Created on successful unlock and destroyed on lock; UI talks to it through
 * `getController()` and observes decrypted state through the `useChat` store.
 */
import {
  cleanNickname,
  cleanReaction,
  type ChatMessage,
  type Contact,
  type Friend,
  type LocalSettings,
  type QueueItem,
  type ServerConfig,
} from '@/domain/types';
import { Api, type MeResponse } from '@/lib/api/endpoints';
import { ApiError, setTokenProvider } from '@/lib/api/http';
import { ChatSocket, type ServerEvent } from '@/lib/api/socket';
import {
  authStatement,
  friendStatement,
  identityFromStored,
  publicKeysOf,
  sign,
  verify,
  verifyPeerKeys,
  wipeIdentity,
  type Identity,
  type StoredIdentity,
} from '@/lib/crypto/identity';
import { decryptMessage, deriveFriendKey, encryptMessage, type MessageBody } from '@/lib/crypto/message';
import type { VaultKeys } from '@/lib/crypto/vault';
import { b64decode, b64encode, randomId } from '@/lib/encoding';
import { isValidAvatar } from '@/lib/media/thumbnails';
import { SecureStore } from '@/lib/storage/secureStore';
import { DEFAULT_SETTINGS, useChat } from '@/state/chat';
import { useSession } from '@/state/session';

interface OutboxEntry {
  peer: string;
  id: string;
  body: MessageBody;
  /** Background update (profile picture): the server must not send a push for it. */
  silent?: boolean;
}

const PUSH_REF_CAP = 500;
const TYPING_TTL_MS = 6000;
const AUTO_DOWNLOAD_MAX = 10 * 1024 * 1024;

export function previewOf(body: MessageBody): string {
  if (body.t === 'text') return body.body.slice(0, 80);
  if (body.t === 'media') {
    const labels = { image: 'Photo', video: 'Video', audio: 'Voice message', gif: 'GIF', file: 'File' } as const;
    return body.caption ? `${labels[body.media.kind]}: ${body.caption.slice(0, 60)}` : labels[body.media.kind];
  }
  if (body.t === 'profile' || body.t === 'nickname' || body.t === 'react') return '';
  return 'Message deleted';
}

export function bodyOf(m: ChatMessage): MessageBody | null {
  if (m.kind === 'text' && m.body !== undefined) return { t: 'text', ts: m.ts, body: m.body, reply_to: m.replyTo };
  if (m.kind === 'media' && m.media)
    return { t: 'media', ts: m.ts, media: m.media, caption: m.caption, reply_to: m.replyTo };
  return null;
}

export class ChatController {
  readonly store: SecureStore;
  readonly identity: Identity;
  readonly config: ServerConfig;
  private displayName: string;
  private avatar: { url: string | null; ts: number };
  private socket: ChatSocket | null = null;
  private token: { value: string; exp: number } | null = null;
  private tokenPending: Promise<string> | null = null;
  private friendKeys = new Map<string, Promise<CryptoKey>>();
  private outbox: OutboxEntry[] = [];
  private pushRefs: Record<string, string> = {};
  private syncing = false;
  private stopped = false;
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = new Map<string, number>();
  private friendsRefresh: Promise<void> | null = null;
  /** Called by the media service; set by services/media.ts to avoid an import cycle. */
  static autoDownload: ((ctrl: ChatController, msg: ChatMessage) => void) | null = null;

  private constructor(store: SecureStore, identity: Identity, stored: StoredIdentity, config: ServerConfig) {
    this.store = store;
    this.identity = identity;
    this.displayName = stored.displayName;
    this.avatar = { url: stored.avatar ?? null, ts: stored.avatarTs ?? 0 };
    this.config = config;
  }

  /** Decrypt identity + local state. Throws if the vault content is unreadable. */
  static async open(keys: VaultKeys, config: ServerConfig): Promise<ChatController> {
    const store = new SecureStore(keys);
    const stored = await store.getKv<StoredIdentity>('identity');
    if (!stored) throw new Error('vault has no identity');
    const identity = await identityFromStored(stored);
    const ctrl = new ChatController(store, identity, stored, config);
    await ctrl.loadLocal();
    return ctrl;
  }

  private async loadLocal(): Promise<void> {
    const settings = { ...DEFAULT_SETTINGS, ...((await this.store.getKv<LocalSettings>('settings')) ?? {}) };
    this.outbox = (await this.store.getKv<OutboxEntry[]>('outbox')) ?? [];
    this.pushRefs = (await this.store.getKv<Record<string, string>>('pushRefs')) ?? {};
    const contacts = await this.store.listContacts();
    useChat.getState().set({
      me: {
        code: this.identity.code,
        displayName: this.displayName,
        discoverable: true,
        showLastSeen: true,
        avatar: this.avatar.url ?? undefined,
      },
      settings,
      contacts: Object.fromEntries(contacts.map((c) => [c.code, c])),
    });
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  start(): void {
    setTokenProvider(() => this.getToken());
    this.socket = new ChatSocket({
      code: this.identity.code,
      signNonce: (nonce) => b64encode(sign(authStatement(nonce), this.identity.signPriv)),
      onEvent: (ev) => void this.onEvent(ev),
      onState: (connection) => useChat.getState().set({ connection }),
      onReady: (token, exp) => {
        this.token = { value: token, exp };
        void this.onReady();
      },
      onAuthFailed: () => this.reRegister(),
    });
    this.socket.start();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.stop();
    this.socket = null;
    setTokenProvider(null);
    this.token = null;
    this.friendKeys.clear();
    this.typingTimers.forEach((t) => clearTimeout(t));
    this.typingTimers.clear();
    wipeIdentity(this.identity);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.exp - 30_000 > Date.now()) return this.token.value;
    if (!this.tokenPending) {
      this.tokenPending = (async () => {
        try {
          const { nonce } = await Api.challenge(this.identity.code);
          const signature = b64encode(sign(authStatement(nonce), this.identity.signPriv));
          const res = await Api.session(this.identity.code, nonce, signature);
          this.token = { value: res.token, exp: res.expires_at };
          return res.token;
        } finally {
          this.tokenPending = null;
        }
      })();
    }
    return this.tokenPending;
  }

  /** Server lost our registration (e.g. database reset): re-register with the same keys. */
  private async reRegister(): Promise<void> {
    const pub = publicKeysOf(this.identity);
    const body = {
      code: this.identity.code,
      display_name: this.displayName,
      identity_key: pub.identityKey,
      agreement_key: pub.agreementKey,
      agreement_key_sig: pub.agreementKeySig,
      discoverable: useChat.getState().me?.discoverable ?? true,
    };
    const username = useChat.getState().me?.username ?? undefined;
    try {
      await Api.register({ ...body, username });
    } catch (e) {
      // Someone took our username meanwhile: register without it; the app then asks for a new one.
      if (!(username && e instanceof ApiError && e.code === 'username_taken')) throw e;
      await Api.register(body);
    }
  }

  private async onReady(): Promise<void> {
    void this.refreshMe();
    await this.refreshFriends();
    this.requestSync();
    this.flushOutbox();
  }

  private async refreshMe(): Promise<void> {
    try {
      const me = await Api.me();
      this.setMe(me);
    } catch {
      /* non-fatal */
    }
  }

  // ---- socket events ------------------------------------------------------------------------------

  private async onEvent(ev: ServerEvent): Promise<void> {
    if (this.stopped) return;
    const chat = useChat.getState();
    switch (ev.type) {
      case 'sync':
        await this.processItems(ev.items);
        if (ev.more) this.socket?.send({ type: 'sync' });
        else this.onSyncComplete();
        break;
      case 'item':
        await this.processItems([ev.item]);
        break;
      case 'sent':
        await this.onSent(ev.id);
        break;
      case 'typing':
        this.onTyping(ev.from, ev.active);
        break;
      case 'presence':
        chat.set({ presence: ev.users });
        break;
      case 'friends_changed':
        await this.refreshFriends();
        break;
      case 'last_seen':
        chat.set({ friends: chat.friends.map((f) => (f.code === ev.code ? { ...f, last_seen: ev.ts } : f)) });
        break;
      case 'error':
        if (ev.id) await this.onSendError(ev.id, ev.code);
        break;
      default:
        break;
    }
  }

  private requestSync(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.socket?.send({ type: 'sync' });
  }

  private onSyncComplete(): void {
    this.syncing = false;
    this.resolvePendingRef();
  }

  /** Route a notification tap (opaque ref) to its conversation, if we know it (spec F9). */
  resolvePendingRef(): void {
    const session = useSession.getState();
    const ref = session.pendingRef;
    if (ref) {
      session.setPendingRef(null);
      const peer = this.pushRefs[ref];
      if (peer && useChat.getState().contacts[peer]) void this.openConversation(peer);
    }
  }

  private async processItems(items: QueueItem[]): Promise<void> {
    const acks: string[] = [];
    for (const item of items) {
      try {
        if (item.kind === 'msg') await this.onIncomingMessage(item);
        else if (item.kind === 'delivered' && item.msg_id) await this.onReceipt(item.from, [item.msg_id], 'delivered');
        else if (item.kind === 'read' && item.msg_ids) await this.onReceipt(item.from, item.msg_ids, 'read');
      } catch {
        /* undecryptable or malformed items are dropped (acked) so they don't loop forever */
      }
      acks.push(item.qid);
    }
    if (acks.length) this.socket?.send({ type: 'ack', qids: acks });
  }

  private async onIncomingMessage(item: QueueItem): Promise<void> {
    const peer = item.from;
    if (!item.msg_id || !item.payload) return;
    if (!useChat.getState().contacts[peer]) await this.refreshFriends();
    const contact = useChat.getState().contacts[peer];
    if (!contact) return;

    const key = await this.friendKey(contact);
    const body = await decryptMessage(key, item.msg_id, peer, this.identity.code, item.payload);
    if (body.t === 'profile') {
      await this.applyRemoteProfile(contact, body.ts, body.avatar);
      return;
    }
    if (body.t === 'nickname') {
      await this.applyRemoteNickname(contact, item.msg_id, body);
      return;
    }
    if (body.t === 'react') {
      await this.applyReaction(peer, body.target, 'peer', body.emoji, body.ts);
      return;
    }
    if (item.ref) await this.rememberRef(item.ref, peer);

    if (body.t === 'delete') {
      await this.applyRemoteDelete(peer, body.target);
      return;
    }
    if (await this.store.getMessage(peer, item.msg_id)) return; // duplicate

    const msg: ChatMessage = {
      id: item.msg_id,
      peer,
      dir: 'in',
      ts: body.ts,
      kind: body.t,
      status: 'received',
      ref: item.ref,
      ...(body.t === 'text' ? { body: body.body } : { media: body.media, caption: body.caption }),
      replyTo: body.reply_to,
    };
    await this.store.putMessage(msg);

    const chat = useChat.getState();
    const viewing = chat.activePeer === peer && document.visibilityState === 'visible';
    await this.touchContact(peer, msg.ts, previewOf(body), viewing ? 0 : 1);
    if (chat.messages[peer]) chat.upsertMessage(msg);
    chat.setTyping(peer, false);
    if (viewing) await this.markRead(peer);
    if (msg.media && msg.media.size <= AUTO_DOWNLOAD_MAX && msg.media.kind !== 'video' && msg.media.kind !== 'file') {
      ChatController.autoDownload?.(this, msg);
    }
  }

  private async applyRemoteProfile(contact: Contact, ts: number, avatar: string | null): Promise<void> {
    if (ts <= (contact.avatarTs ?? 0)) return; // stale or replayed update
    if (avatar !== null && !isValidAvatar(avatar)) return;
    await this.saveContact({ ...contact, avatar: avatar ?? undefined, avatarTs: ts });
  }

  private async applyRemoteNickname(
    contact: Contact,
    msgId: string,
    body: { ts: number; target: string; name: string | null },
  ): Promise<void> {
    const forMe = body.target === this.identity.code;
    if (!forMe && body.target !== contact.code) return;
    const name = body.name === null ? null : cleanNickname(body.name);
    if (body.name !== null && name === null) return;
    if (body.ts <= ((forMe ? contact.myNicknameTs : contact.nicknameTs) ?? 0)) return; // stale or replayed
    await this.saveContact(
      forMe
        ? { ...contact, myNickname: name ?? undefined, myNicknameTs: body.ts }
        : { ...contact, nickname: name ?? undefined, nicknameTs: body.ts },
    );
    const who = contact.displayName;
    const text = forMe
      ? name
        ? `${who} set your nickname to "${name}"`
        : `${who} removed your nickname`
      : name
        ? `${who} set their nickname to "${name}"`
        : `${who} removed their nickname`;
    await this.addNotice(contact.code, msgId, 'in', text);
  }

  /** Local system line in the chat (not sent as-is). */
  private async addNotice(peer: string, id: string, dir: 'in' | 'out', text: string): Promise<void> {
    const msg: ChatMessage = {
      id,
      peer,
      dir,
      ts: Date.now(),
      kind: 'notice',
      body: text,
      status: dir === 'in' ? 'received' : 'sent',
      readSent: true, // never send read receipts for notices
    };
    await this.store.putMessage(msg);
    const chat = useChat.getState();
    if (chat.messages[peer]) chat.upsertMessage(msg);
    await this.touchContact(peer, msg.ts, text, 0);
  }

  /** Store a reaction on a message if it is newer than the one we have. Returns whether it changed. */
  private async applyReaction(
    peer: string,
    target: string,
    who: 'me' | 'peer',
    value: string | null,
    ts: number,
  ): Promise<boolean> {
    const emoji = value === null ? null : cleanReaction(value);
    if (value !== null && emoji === null) return false;
    const msg = await this.store.getMessage(peer, target);
    if (!msg || msg.kind === 'notice' || msg.deleted) return false;
    if (ts <= (msg.reactions?.[who]?.ts ?? 0)) return false; // stale or replayed
    const updated: ChatMessage = { ...msg, reactions: { ...msg.reactions, [who]: { emoji, ts } } };
    await this.store.putMessage(updated);
    useChat.getState().upsertMessage(updated);
    return true;
  }

  private async applyRemoteDelete(peer: string, target: string): Promise<void> {
    const msg = await this.store.getMessage(peer, target);
    if (!msg || msg.dir !== 'in') return;
    if (msg.media) await this.store.deleteMedia(msg.media.blobId);
    const updated: ChatMessage = { ...msg, deleted: true, body: undefined, media: undefined, caption: undefined, reactions: undefined };
    await this.store.putMessage(updated);
    useChat.getState().upsertMessage(updated);
  }

  private async onReceipt(peer: string, ids: string[], status: 'delivered' | 'read'): Promise<void> {
    const rank = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4, received: 0 } as const;
    for (const id of ids) {
      const msg = await this.store.getMessage(peer, id);
      if (!msg || msg.dir !== 'out' || rank[msg.status] >= rank[status]) continue;
      const updated = { ...msg, status };
      await this.store.putMessage(updated);
      useChat.getState().upsertMessage(updated);
    }
  }

  private async onSent(id: string): Promise<void> {
    const entry = this.outbox.find((e) => e.id === id);
    if (!entry) return;
    this.outbox = this.outbox.filter((e) => e.id !== id);
    await this.store.setKv('outbox', this.outbox);
    const msg = await this.store.getMessage(entry.peer, id);
    if (msg && msg.status === 'sending') {
      const updated = { ...msg, status: 'sent' as const };
      await this.store.putMessage(updated);
      useChat.getState().upsertMessage(updated);
    }
  }

  private async onSendError(id: string, code: string): Promise<void> {
    if (code !== 'not_friends' && code !== 'payload_too_large' && code !== 'invalid') return;
    const entry = this.outbox.find((e) => e.id === id);
    if (!entry) return;
    this.outbox = this.outbox.filter((e) => e.id !== id);
    await this.store.setKv('outbox', this.outbox);
    const msg = await this.store.getMessage(entry.peer, id);
    if (msg) {
      const updated = { ...msg, status: 'failed' as const };
      await this.store.putMessage(updated);
      useChat.getState().upsertMessage(updated);
    }
  }

  private onTyping(peer: string, active: boolean): void {
    const chat = useChat.getState();
    chat.setTyping(peer, active);
    const prev = this.typingTimers.get(peer);
    if (prev) clearTimeout(prev);
    if (active) this.typingTimers.set(peer, setTimeout(() => useChat.getState().setTyping(peer, false), TYPING_TTL_MS));
  }

  private async rememberRef(ref: string, peer: string): Promise<void> {
    this.pushRefs[ref] = peer;
    const keys = Object.keys(this.pushRefs);
    if (keys.length > PUSH_REF_CAP) keys.slice(0, keys.length - PUSH_REF_CAP).forEach((k) => delete this.pushRefs[k]);
    await this.store.setKv('pushRefs', this.pushRefs);
  }

  // ---- keys -----------------------------------------------------------------------------------------

  friendKey(contact: Contact): Promise<CryptoKey> {
    let k = this.friendKeys.get(contact.code);
    if (!k) {
      k = deriveFriendKey(this.identity.dhPriv, b64decode(contact.agreementKey), this.identity.code, contact.code);
      this.friendKeys.set(contact.code, k);
    }
    return k;
  }

  // ---- sending --------------------------------------------------------------------------------------

  private async enqueue(peer: string, id: string, body: MessageBody, silent = false): Promise<void> {
    const entry: OutboxEntry = silent ? { peer, id, body, silent } : { peer, id, body };
    this.outbox.push(entry);
    await this.store.setKv('outbox', this.outbox);
    await this.transmit(entry);
  }

  private async transmit(entry: OutboxEntry): Promise<void> {
    const contact = useChat.getState().contacts[entry.peer];
    if (!contact || !this.socket?.isReady) return;
    const payload = await encryptMessage(
      await this.friendKey(contact),
      entry.id,
      this.identity.code,
      entry.peer,
      entry.body,
    );
    this.socket.send({ type: 'send', id: entry.id, to: entry.peer, payload, ...(entry.silent ? { silent: true } : {}) });
  }

  private flushOutbox(): void {
    for (const entry of [...this.outbox]) void this.transmit(entry);
  }

  /** Persist an outgoing message locally (status "sending") without transmitting it yet. */
  async createOutgoing(peer: string, partial: Pick<ChatMessage, 'kind'> & Partial<ChatMessage>): Promise<ChatMessage> {
    const msg: ChatMessage = { id: randomId(), peer, dir: 'out', ts: Date.now(), status: 'sending', ...partial };
    await this.store.putMessage(msg);
    useChat.getState().upsertMessage(msg);
    return msg;
  }

  /** Transmit an already-persisted outgoing message (text, or media after upload). */
  async dispatch(msg: ChatMessage): Promise<void> {
    const body = bodyOf(msg);
    if (!body) return;
    await this.store.putMessage(msg);
    useChat.getState().upsertMessage(msg);
    await this.touchContact(msg.peer, msg.ts, previewOf(body), 0);
    await this.enqueue(msg.peer, msg.id, body);
  }

  async sendText(peer: string, text: string, replyTo?: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const msg = await this.createOutgoing(peer, { kind: 'text', body, replyTo });
    await this.dispatch(msg);
    this.sendTyping(peer, false);
  }

  async markFailed(msg: ChatMessage): Promise<void> {
    const updated = { ...msg, status: 'failed' as const };
    await this.store.putMessage(updated);
    useChat.getState().upsertMessage(updated);
  }

  async retry(msg: ChatMessage): Promise<void> {
    if (msg.kind === 'text') await this.dispatch({ ...msg, status: 'sending' });
  }

  async deleteForMe(peer: string, id: string): Promise<void> {
    const msg = await this.store.getMessage(peer, id);
    if (msg?.media) await this.store.deleteMedia(msg.media.blobId);
    await this.store.deleteMessage(peer, id);
    this.outbox = this.outbox.filter((e) => e.id !== id);
    await this.store.setKv('outbox', this.outbox);
    useChat.getState().removeMessage(peer, id);
  }

  async deleteForEveryone(peer: string, id: string): Promise<void> {
    const msg = await this.store.getMessage(peer, id);
    if (!msg || msg.dir !== 'out') return;
    await this.enqueue(peer, randomId(), { t: 'delete', ts: Date.now(), target: id });
    if (msg.media) await this.store.deleteMedia(msg.media.blobId);
    const updated: ChatMessage = { ...msg, deleted: true, body: undefined, media: undefined, caption: undefined, reactions: undefined };
    await this.store.putMessage(updated);
    useChat.getState().upsertMessage(updated);
  }

  /**
   * Set my reaction on a message (null removes it). The peer gets it in an end-to-end encrypted,
   * silent `react` envelope; both phones keep the newest reaction per person.
   */
  async react(peer: string, id: string, emoji: string | null): Promise<void> {
    const msg = await this.store.getMessage(peer, id);
    if (!msg) return;
    const ts = Math.max(Date.now(), (msg.reactions?.me?.ts ?? 0) + 1);
    if (!(await this.applyReaction(peer, id, 'me', emoji, ts))) return;
    if (msg.status === 'failed' || msg.status === 'sending') return; // the peer never got the message
    await this.enqueue(peer, randomId(), { t: 'react', ts, target: id, emoji }, true);
  }

  sendTyping(peer: string, active: boolean): void {
    const now = Date.now();
    const last = this.lastTypingSent.get(peer) ?? 0;
    if (active && now - last < 3000) return;
    this.lastTypingSent.set(peer, active ? now : 0);
    this.socket?.send({ type: 'typing', to: peer, active });
  }

  // ---- conversations --------------------------------------------------------------------------------

  async openConversation(peer: string): Promise<void> {
    const msgs = await this.store.listMessages(peer);
    const chat = useChat.getState();
    chat.setConversation(peer, msgs);
    chat.set({ activePeer: peer });
    await this.markRead(peer);
  }

  closeConversation(): void {
    useChat.getState().set({ activePeer: null });
  }

  async markRead(peer: string): Promise<void> {
    const chat = useChat.getState();
    const contact = chat.contacts[peer];
    if (contact?.unread) await this.saveContact({ ...contact, unread: 0 });
    const unread = (chat.messages[peer] ?? []).filter((m) => m.dir === 'in' && !m.readSent && !m.deleted);
    if (!unread.length) return;
    if (chat.settings.readReceipts) {
      const ids = unread.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 200) this.socket?.send({ type: 'read', to: peer, ids: ids.slice(i, i + 200) });
    }
    for (const m of unread) {
      const updated = { ...m, readSent: true };
      await this.store.putMessage(updated);
      useChat.getState().upsertMessage(updated);
    }
  }

  private async touchContact(peer: string, ts: number, preview: string, unreadDelta: number): Promise<void> {
    const c = useChat.getState().contacts[peer];
    if (!c) return;
    await this.saveContact({
      ...c,
      lastTs: Math.max(c.lastTs ?? 0, ts),
      lastPreview: preview,
      unread: (c.unread ?? 0) + unreadDelta,
    });
  }

  private async saveContact(c: Contact): Promise<void> {
    await this.store.putContact(c);
    useChat.getState().upsertContact(c);
  }

  async deleteConversation(peer: string): Promise<void> {
    const msgs = await this.store.listMessages(peer);
    for (const m of msgs) if (m.media) await this.store.deleteMedia(m.media.blobId);
    await this.store.deleteConversation(peer);
    const c = useChat.getState().contacts[peer];
    if (c) await this.saveContact({ ...c, lastPreview: undefined, unread: 0 });
    useChat.getState().setConversation(peer, []);
  }

  // ---- friends --------------------------------------------------------------------------------------

  refreshFriends(): Promise<void> {
    if (!this.friendsRefresh) {
      this.friendsRefresh = this.doRefreshFriends().finally(() => (this.friendsRefresh = null));
    }
    return this.friendsRefresh;
  }

  private async doRefreshFriends(): Promise<void> {
    let friends: Friend[];
    try {
      friends = (await Api.friends()).friends;
    } catch {
      return;
    }
    const verified: Friend[] = [];
    for (const f of friends) if (await this.verifyFriend(f)) verified.push(f);
    if (this.stopped) return;
    useChat.getState().set({ friends: verified });
    for (const f of verified) {
      if (f.status !== 'accepted') continue;
      const existing = useChat.getState().contacts[f.code];
      if (existing) {
        if (existing.displayName !== f.display_name) await this.saveContact({ ...existing, displayName: f.display_name });
        continue; // keys are bound to the code and never change: keep the trusted ones
      }
      await this.saveContact({
        code: f.code,
        displayName: f.display_name,
        identityKey: f.identity_key,
        agreementKey: f.agreement_key,
        agreementKeySig: f.agreement_key_sig,
        addedAt: Date.now(),
      });
      if (this.avatar.url) await this.sendProfile(f.code); // new friend: share our picture
    }
  }

  /** Verify the peer's key binding and every statement the peer signed. */
  private async verifyFriend(f: Friend): Promise<boolean> {
    const keysOk = await verifyPeerKeys(f.code, {
      identityKey: f.identity_key,
      agreementKey: f.agreement_key,
      agreementKeySig: f.agreement_key_sig,
    });
    if (!keysOk) return false;
    if (f.status === 'blocked') return true;
    const peerKey = b64decode(f.identity_key);
    const me = this.identity.code;
    const check = (kind: 'freq' | 'facc', ts: number | null, sig: string | null) =>
      ts !== null &&
      sig !== null &&
      verify(b64decode(sig), friendStatement(kind, f.code, me, f.identity_key, f.agreement_key, ts), peerKey);
    if (f.direction === 'incoming') return check('freq', f.request_ts, f.request_sig);
    if (f.status === 'accepted') return check('facc', f.accept_ts, f.accept_sig);
    return true; // outgoing pending/declined: the request is our own statement
  }

  async sendFriendRequest(to: string): Promise<void> {
    const ts = Date.now();
    const pub = publicKeysOf(this.identity);
    const sig = sign(friendStatement('freq', this.identity.code, to, pub.identityKey, pub.agreementKey, ts), this.identity.signPriv);
    await Api.requestFriend(to, ts, b64encode(sig));
    await this.refreshFriends();
  }

  async acceptFriend(code: string): Promise<void> {
    const ts = Date.now();
    const pub = publicKeysOf(this.identity);
    const sig = sign(friendStatement('facc', this.identity.code, code, pub.identityKey, pub.agreementKey, ts), this.identity.signPriv);
    await Api.acceptFriend(code, ts, b64encode(sig));
    await this.refreshFriends();
  }

  async friendAction(code: string, action: 'decline' | 'cancel' | 'block' | 'unblock'): Promise<void> {
    await Api.friendAction(code, action);
    await this.refreshFriends();
  }

  // ---- profile & settings ---------------------------------------------------------------------------

  async updateSettings(patch: Partial<LocalSettings>): Promise<void> {
    const settings = { ...useChat.getState().settings, ...patch };
    await this.store.setKv('settings', settings);
    useChat.getState().set({ settings });
  }

  private setMe(res: MeResponse): void {
    useChat.getState().set({
      me: {
        code: res.code,
        displayName: res.display_name,
        username: res.username ?? null,
        discoverable: res.discoverable,
        showLastSeen: res.show_last_seen ?? true,
        avatar: this.avatar.url ?? undefined,
      },
    });
  }

  /**
   * Set (data: URL) or remove (null) the profile picture. It is never uploaded in the clear: each
   * accepted friend gets it inside an end-to-end encrypted `profile` envelope, sent silently.
   */
  async setAvatar(url: string | null): Promise<void> {
    if (url !== null && !isValidAvatar(url)) throw new Error('Unsupported picture.');
    this.avatar = { url, ts: Math.max(Date.now(), this.avatar.ts + 1) };
    const stored = await this.store.getKv<StoredIdentity>('identity');
    if (stored) await this.store.setKv('identity', { ...stored, avatar: url ?? undefined, avatarTs: this.avatar.ts });
    const me = useChat.getState().me;
    if (me) useChat.getState().set({ me: { ...me, avatar: url ?? undefined } });
    const contacts = useChat.getState().contacts;
    for (const f of useChat.getState().friends) {
      if (f.status === 'accepted' && contacts[f.code]) await this.sendProfile(f.code);
    }
  }

  private async sendProfile(peer: string): Promise<void> {
    // Only the latest picture matters: drop queued, not yet sent profile updates for this peer.
    this.outbox = this.outbox.filter((e) => !(e.peer === peer && e.body.t === 'profile'));
    await this.enqueue(peer, randomId(), { t: 'profile', ts: this.avatar.ts, avatar: this.avatar.url }, true);
  }

  /**
   * Set (or clear with null) the nickname for the contact (`them`) or for me (`me`) in this chat. Both
   * phones show it: the change goes to the peer in an end-to-end encrypted `nickname` envelope.
   */
  async setNickname(peer: string, who: 'them' | 'me', value: string | null): Promise<void> {
    const contact = useChat.getState().contacts[peer];
    if (!contact) return;
    const name = value === null ? null : cleanNickname(value);
    if (value !== null && name === null) throw new Error('Nickname must be 1–40 characters.');
    const prevTs = (who === 'me' ? contact.myNicknameTs : contact.nicknameTs) ?? 0;
    const ts = Math.max(Date.now(), prevTs + 1);
    await this.saveContact(
      who === 'me'
        ? { ...contact, myNickname: name ?? undefined, myNicknameTs: ts }
        : { ...contact, nickname: name ?? undefined, nicknameTs: ts },
    );
    const id = randomId();
    const text =
      who === 'me'
        ? name
          ? `You set your nickname to "${name}"`
          : 'You removed your nickname'
        : name
          ? `You set ${contact.displayName}'s nickname to "${name}"`
          : `You removed ${contact.displayName}'s nickname`;
    await this.addNotice(peer, id, 'out', text);
    const target = who === 'me' ? this.identity.code : peer;
    await this.enqueue(peer, id, { t: 'nickname', ts, target, name }, true);
  }

  async updateProfile(patch: {
    displayName?: string;
    username?: string;
    discoverable?: boolean;
    showLastSeen?: boolean;
  }): Promise<void> {
    const res = await Api.updateMe({
      display_name: patch.displayName,
      username: patch.username,
      discoverable: patch.discoverable,
      show_last_seen: patch.showLastSeen,
    });
    this.setMe(res);
    if (patch.showLastSeen !== undefined) await this.refreshFriends(); // visibility is reciprocal
    if (patch.displayName) {
      this.displayName = res.display_name;
      const stored = await this.store.getKv<StoredIdentity>('identity');
      if (stored) await this.store.setKv('identity', { ...stored, displayName: res.display_name });
    }
  }

  isApiError(e: unknown, code?: string): e is ApiError {
    return e instanceof ApiError && (code === undefined || e.code === code);
  }
}
