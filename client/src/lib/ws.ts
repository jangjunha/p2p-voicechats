import type { Channel, Member, StickerMeta, WireMessage } from './api';

export type ServerEvent =
  | { type: 'hello'; user_id: string }
  | { type: 'pong' }
  | { type: 'message_new'; channel_id: string; message: WireMessage }
  | { type: 'call_roster'; channel_id: string; participants: string[] }
  | { type: 'call_peer_joined'; channel_id: string; user_id: string }
  | { type: 'call_peer_left'; channel_id: string; user_id: string }
  | { type: 'signal'; channel_id: string; from: string; payload: unknown; sig: string }
  | { type: 'member_joined'; space_id: string; user: Member }
  | { type: 'member_removed'; space_id: string; user_id: string }
  | { type: 'key_request'; space_id: string; user: { user_id: string; kem_pub: string } }
  | { type: 'keys_updated'; space_id: string; current_epoch: number }
  | { type: 'channel_created'; space_id: string; channel: Channel }
  | { type: 'sticker_added'; space_id: string; sticker: StickerMeta }
  | { type: 'sticker_removed'; space_id: string; sticker_id: string };

export type ClientEvent =
  | { type: 'call_join'; channel_id: string }
  | { type: 'call_leave'; channel_id: string }
  | { type: 'signal'; channel_id: string; to: string; payload: unknown; sig: string }
  | { type: 'ping' };

/**
 * Event socket with automatic reconnection. The server treats a dropped
 * socket as leaving all calls, so listeners get `open` to re-join state.
 */
export class EventSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(ev: ServerEvent) => void>();
  private openListeners = new Set<() => void>();

  // Keep the socket alive through reverse-proxy idle timeouts (e.g. nginx's
  // default 60s proxy_read_timeout), which otherwise drop the connection.
  private static readonly PING_INTERVAL_MS = 30_000;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  connect() {
    this.closed = false;
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    // Token via WebSocket subprotocol; browsers can't set Authorization here.
    const ws = new WebSocket(url, ['bearer', this.token]);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 500;
      this.stopPing();
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), EventSocket.PING_INTERVAL_MS);
      for (const l of this.openListeners) l();
    };
    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const l of this.listeners) l(ev);
    };
    ws.onclose = () => {
      this.ws = null;
      this.stopPing();
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    };
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close() {
    this.closed = true;
    this.stopPing();
    this.ws?.close();
  }

  send(ev: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(ev));
    }
  }

  onEvent(l: (ev: ServerEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
}
