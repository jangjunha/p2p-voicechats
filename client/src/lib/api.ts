/** Thin typed wrapper over the REST API (docs/PROTOCOL.md). */

export interface Channel {
  id: string;
  name: string;
}

export interface Space {
  id: string;
  name: string;
  owner_id: string;
  current_epoch: number;
  channels: Channel[];
}

export interface Member {
  user_id: string;
  name: string;
  role: 'owner' | 'member';
  sign_pub: string;
  kem_pub: string;
}

export interface WireMessage {
  id: string;
  sender_id: string;
  epoch: number;
  nonce: string;
  ct: string;
  sig: string;
  created_at: number;
}

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  ttl_secs: number;
}

/** Sticker metadata (no ciphertext); the blob is fetched separately. */
export interface StickerMeta {
  id: string;
  name: string;
  epoch: number;
  created_by: string;
  created_at: number;
}

/** A sticker with its encrypted webp blob. */
export interface StickerFull extends StickerMeta {
  nonce: string;
  ct: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, json.error ?? 'unknown', json.message ?? res.statusText);
    }
    return json as T;
  }

  // auth
  register(name: string, signPub: string, kemPub: string) {
    return this.req<{ user_id: string }>('POST', '/register', {
      name,
      sign_pub: signPub,
      kem_pub: kemPub,
    });
  }
  challenge(userId: string) {
    return this.req<{ nonce: string }>('GET', `/auth/challenge?user_id=${encodeURIComponent(userId)}`);
  }
  login(userId: string, nonce: string, sig: string) {
    return this.req<{ token: string; user: Member }>('POST', '/auth/login', {
      user_id: userId,
      nonce,
      sig,
    });
  }

  // spaces
  createSpace(name: string) {
    return this.req<Space>('POST', '/spaces', { name });
  }
  listSpaces() {
    return this.req<{ spaces: Space[] }>('GET', '/spaces');
  }
  listMembers(spaceId: string) {
    return this.req<{ members: Member[] }>('GET', `/spaces/${spaceId}/members`);
  }
  removeMember(spaceId: string, userId: string) {
    return this.req<{ ok: true }>('DELETE', `/spaces/${spaceId}/members/${userId}`);
  }
  createChannel(spaceId: string, name: string) {
    return this.req<Channel>('POST', `/spaces/${spaceId}/channels`, { name });
  }
  createInvite(spaceId: string) {
    return this.req<{ token: string; expires_at: number }>('POST', `/spaces/${spaceId}/invites`, {});
  }
  acceptInvite(token: string) {
    return this.req<Space>('POST', `/invites/${encodeURIComponent(token)}/accept`);
  }

  // keys
  uploadKeys(spaceId: string, epoch: number, wraps: { user_id: string; wrapped: string }[]) {
    return this.req<{ ok: true; current_epoch: number }>('POST', `/spaces/${spaceId}/keys`, {
      epoch,
      wraps,
    });
  }
  fetchKeys(spaceId: string) {
    return this.req<{ current_epoch: number; wraps: { epoch: number; wrapped: string }[] }>(
      'GET',
      `/spaces/${spaceId}/keys`,
    );
  }

  // messages
  postMessage(channelId: string, msg: { epoch: number; nonce: string; ct: string; sig: string }) {
    return this.req<{ id: string; created_at: number }>('POST', `/channels/${channelId}/messages`, msg);
  }
  fetchMessages(channelId: string, before?: string, limit = 50) {
    const q = new URLSearchParams();
    if (before) q.set('before', before);
    q.set('limit', String(limit));
    return this.req<{ messages: WireMessage[] }>('GET', `/channels/${channelId}/messages?${q}`);
  }

  // stickers
  listStickers(spaceId: string) {
    return this.req<{ stickers: StickerMeta[] }>('GET', `/spaces/${spaceId}/stickers`);
  }
  fetchSticker(spaceId: string, stickerId: string) {
    return this.req<StickerFull>('GET', `/spaces/${spaceId}/stickers/${stickerId}`);
  }
  createSticker(spaceId: string, sticker: { name: string; epoch: number; nonce: string; ct: string }) {
    return this.req<StickerMeta>('POST', `/spaces/${spaceId}/stickers`, sticker);
  }
  deleteSticker(spaceId: string, stickerId: string) {
    return this.req<{ ok: true }>('DELETE', `/spaces/${spaceId}/stickers/${stickerId}`);
  }

  // turn
  turnCredentials() {
    return this.req<TurnCredentials>('GET', '/turn-credentials');
  }
}
