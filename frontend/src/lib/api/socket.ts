/**
 * Authenticated WebSocket with challenge-response auth, automatic reconnect (exponential backoff with
 * jitter) and heartbeat. Emits typed server events; knows nothing about encryption.
 */
import type { PresenceUser, QueueItem } from '@/domain/types';

export type ServerEvent =
  | { type: 'challenge'; nonce: string }
  | { type: 'ready'; token: string; expires_at: number; server_time: number }
  | { type: 'sync'; items: QueueItem[]; more: boolean }
  | { type: 'item'; item: QueueItem }
  | { type: 'sent'; id: string; ts: number }
  | { type: 'typing'; from: string; active: boolean }
  | { type: 'presence'; users: PresenceUser[] }
  | { type: 'friends_changed' }
  | { type: 'error'; code: string; message: string; id?: string }
  | { type: 'pong' };

export type ClientEvent =
  | { type: 'sync' }
  | { type: 'send'; id: string; to: string; payload: string }
  | { type: 'ack'; qids: string[] }
  | { type: 'read'; to: string; ids: string[] }
  | { type: 'typing'; to: string; active: boolean }
  | { type: 'ping' };

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface SocketOptions {
  code: string;
  signNonce: (nonce: string) => string;
  onEvent: (ev: ServerEvent) => void;
  onState: (s: ConnectionState) => void;
  onReady: (token: string, expiresAt: number) => void;
  /** Server rejected our signature or no longer knows our code (e.g. after a server reset). */
  onAuthFailed?: () => Promise<void>;
}

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private ready = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly onOnline = () => this.reconnectNow();

  constructor(private readonly opts: SocketOptions) {}

  start(): void {
    this.closed = false;
    window.addEventListener('online', this.onOnline);
    this.connect();
  }

  get isReady(): boolean {
    return this.ready;
  }

  send(ev: ClientEvent): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(ev));
    return true;
  }

  stop(): void {
    this.closed = true;
    window.removeEventListener('online', this.onOnline);
    this.clearTimers();
    this.ready = false;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000);
      this.ws = null;
    }
    this.opts.onState('offline');
  }

  reconnectNow(): void {
    if (this.closed || this.ready) return;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.opts.onState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;

    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (ev.type === 'challenge') {
        ws.send(JSON.stringify({ type: 'auth', code: this.opts.code, signature: this.opts.signNonce(ev.nonce) }));
        return;
      }
      if (ev.type === 'ready') {
        this.ready = true;
        this.attempt = 0;
        this.startHeartbeat();
        this.opts.onState('online');
        this.opts.onReady(ev.token, ev.expires_at);
        return;
      }
      this.opts.onEvent(ev);
    };

    ws.onclose = (e) => {
      this.ready = false;
      this.clearTimers();
      if (this.closed) return;
      if (e.code === 4401 && this.opts.onAuthFailed && this.attempt < 3) {
        void this.opts.onAuthFailed().catch(() => undefined);
      }
      this.opts.onState('connecting');
      const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
      this.attempt++;
      this.reconnectTimer = setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
    };

    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
  }
}
