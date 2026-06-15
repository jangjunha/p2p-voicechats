/**
 * Central app state (Svelte 5 runes) and orchestration: multi-server auth,
 * spaces, key management, message encrypt/decrypt, and call lifecycle.
 *
 * Multi-server model: the client logs into N servers in parallel, each with its
 * own Identity{sign_key, kem_key}, Api, and EventSocket. All per-server reactive
 * state (spaces/members/messages/locked) is keyed by `serverId`; the non-reactive
 * connection objects (identity, api, socket, space keys) live in `conns`.
 */
import { Api, type Member, type Space, type WireMessage } from './api';
import { CallManager, DEFAULT_BROADCAST, type BroadcastSettings, type PeerStats } from './call';
import { credentials, migrateLegacyAccount, type AccountIndex } from './credentials';
import {
  b64u,
  decryptMessage,
  deserializeIdentity,
  encryptMessage,
  generateIdentity,
  generateSpaceKey,
  loginSignature,
  openBox,
  sealBox,
  serializeIdentity,
  unb64u,
  type Identity,
} from './crypto';
import { EventSocket, type ServerEvent } from './ws';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: number;
  ok: boolean; // false = could not decrypt/verify
}

export interface ActiveCall {
  serverId: string;
  selfId: string;
  channelId: string;
  spaceId: string;
  manager: CallManager;
  participants: string[];
  remoteStreams: Record<string, MediaStream[]>;
  stats: Record<string, PeerStats>;
  micMuted: boolean;
  broadcasting: boolean;
}

/** Reactive, non-secret view of a connected server, shown in the UI. */
export interface ServerView {
  id: string;
  serverUrl: string;
  userId: string;
  userName: string;
  status: 'connecting' | 'online' | 'offline';
  error: string | null;
}

const LS_LAST_SERVER = 'vc.lastServerUrl';

/** Composite key for per-server reactive maps. `|` never appears in UUIDs. */
function ck(serverId: string, id: string): string {
  return `${serverId}|${id}`;
}

/**
 * Non-reactive holder for one server connection: secrets and live handles that
 * must never land in reactive state.
 */
class ServerConn {
  socket: EventSocket | null = null;
  /** epoch → key, per space. Sensitive: kept out of reactive state. */
  spaceKeys = new Map<string, Map<number, Uint8Array>>();

  constructor(
    public id: string,
    public serverUrl: string,
    public userId: string,
    public identity: Identity,
    public api: Api,
  ) {}
}

class AppStore {
  phase = $state<'loading' | 'onboarding' | 'main'>('loading');
  error = $state<string | null>(null);

  servers = $state<ServerView[]>([]);
  /** serverId → spaces */
  spaces = $state<Record<string, Space[]>>({});
  /** `serverId|spaceId` → members */
  members = $state<Record<string, Member[]>>({});
  /** `serverId|channelId` → messages */
  messages = $state<Record<string, ChatMessage[]>>({});
  /** `serverId|spaceId` → true when we lack the current epoch key */
  lockedSpaces = $state<Record<string, boolean>>({});

  activeServerId = $state<string | null>(null);
  activeSpaceId = $state<string | null>(null);
  activeChannelId = $state<string | null>(null);

  call = $state<ActiveCall | null>(null);
  broadcastSettings = $state<BroadcastSettings>({ ...DEFAULT_BROADCAST });

  /** serverId → live connection. Never reactive. */
  private conns = new Map<string, ServerConn>();

  // ---------- selectors ----------

  get activeServer(): ServerView | null {
    return this.servers.find((s) => s.id === this.activeServerId) ?? null;
  }

  get activeSpace(): Space | null {
    if (!this.activeServerId) return null;
    return this.spaces[this.activeServerId]?.find((s) => s.id === this.activeSpaceId) ?? null;
  }

  spacesOf(serverId: string): Space[] {
    return this.spaces[serverId] ?? [];
  }

  membersOf(serverId: string, spaceId: string): Member[] {
    return this.members[ck(serverId, spaceId)] ?? [];
  }

  messagesOf(serverId: string, channelId: string): ChatMessage[] {
    return this.messages[ck(serverId, channelId)] ?? [];
  }

  lockedOf(serverId: string, spaceId: string): boolean {
    return this.lockedSpaces[ck(serverId, spaceId)] === true;
  }

  userIdOf(serverId: string): string | null {
    return this.servers.find((s) => s.id === serverId)?.userId ?? null;
  }

  memberName(serverId: string, spaceId: string, userId: string): string {
    return (
      this.membersOf(serverId, spaceId).find((m) => m.user_id === userId)?.name ??
      userId.slice(0, 8)
    );
  }

  signPubOf(serverId: string, spaceId: string, userId: string): Uint8Array | undefined {
    const m = this.membersOf(serverId, spaceId).find((m) => m.user_id === userId);
    return m ? unb64u(m.sign_pub) : undefined;
  }

  private conn(serverId: string): ServerConn | undefined {
    return this.conns.get(serverId);
  }

  // ---------- server view bookkeeping ----------

  private upsertServer(view: ServerView) {
    const i = this.servers.findIndex((s) => s.id === view.id);
    if (i === -1) this.servers = [...this.servers, view];
    else this.servers[i] = view;
  }

  private patchServer(serverId: string, patch: Partial<ServerView>) {
    const i = this.servers.findIndex((s) => s.id === serverId);
    const cur = this.servers[i];
    if (cur) this.servers[i] = { ...cur, ...patch };
  }

  // ---------- lifecycle ----------

  async bootstrap() {
    await migrateLegacyAccount();
    const vault = credentials.loadVault();
    if (vault.length === 0) {
      this.phase = 'onboarding';
      return;
    }
    // Log into every account in parallel; one failure doesn't block the rest.
    await Promise.all(vault.map((acc) => this.connectAccount(acc)));
    this.phase = 'main';
    this.selectFirstAvailable();
  }

  private selectFirstAvailable() {
    if (this.activeServerId && this.activeSpace) return;
    for (const sv of this.servers) {
      const sp = this.spaces[sv.id]?.[0];
      if (sp) {
        void this.selectChannel(sv.id, sp.id, sp.channels[0]?.id ?? null);
        return;
      }
    }
  }

  private async connectAccount(acc: AccountIndex) {
    this.upsertServer({
      id: acc.id,
      serverUrl: acc.serverUrl,
      userId: acc.userId,
      userName: acc.name,
      status: 'connecting',
      error: null,
    });
    const secret = await credentials.getSecret(acc.id);
    if (!secret) {
      this.patchServer(acc.id, { status: 'offline', error: 'missing credentials' });
      return;
    }
    const identity = deserializeIdentity(secret.identity);
    const api = new Api(acc.serverUrl, secret.token);
    const conn = new ServerConn(acc.id, acc.serverUrl, acc.userId, identity, api);
    this.conns.set(acc.id, conn);
    try {
      await this.relogin(conn);
      await this.refreshSpaces(acc.id);
      this.connectSocket(conn);
      this.patchServer(acc.id, { status: 'online' });
    } catch (e) {
      this.patchServer(acc.id, { status: 'offline', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async relogin(conn: ServerConn) {
    const { nonce } = await conn.api.challenge(conn.userId);
    const { token, user } = await conn.api.login(
      conn.userId,
      nonce,
      loginSignature(conn.identity, nonce),
    );
    conn.api.token = token;
    this.patchServer(conn.id, { userName: user.name });
    await this.persistSecret(conn);
  }

  private async persistSecret(conn: ServerConn) {
    await credentials.setSecret(conn.id, {
      identity: serializeIdentity(conn.identity),
      token: conn.api.token,
    });
  }

  private saveIndex(acc: AccountIndex) {
    const vault = credentials.loadVault();
    const i = vault.findIndex((a) => a.id === acc.id);
    if (i === -1) vault.push(acc);
    else vault[i] = acc;
    credentials.saveVault(vault);
  }

  /** Register a fresh identity on a server and connect. */
  async addServer(serverUrl: string, name: string) {
    const url = serverUrl.replace(/\/+$/, '');
    localStorage.setItem(LS_LAST_SERVER, url);
    const identity = generateIdentity();
    const api = new Api(url);
    const { user_id } = await api.register(name, b64u(identity.signPub), b64u(identity.kemPub));
    await this.attachConn(crypto.randomUUID(), url, user_id, name, identity, api);
  }

  /** Connect to a server using an exported identity backup. */
  async importServer(serverUrl: string, userId: string, identityJson: string) {
    const url = serverUrl.replace(/\/+$/, '');
    localStorage.setItem(LS_LAST_SERVER, url);
    const identity = deserializeIdentity(identityJson);
    const api = new Api(url);
    await this.attachConn(crypto.randomUUID(), url, userId.trim(), userId.trim(), identity, api);
  }

  private async attachConn(
    id: string,
    serverUrl: string,
    userId: string,
    name: string,
    identity: Identity,
    api: Api,
  ) {
    const conn = new ServerConn(id, serverUrl, userId, identity, api);
    this.conns.set(id, conn);
    this.upsertServer({ id, serverUrl, userId, userName: name, status: 'connecting', error: null });
    // Persist identity immediately so a later login failure doesn't lose the key.
    await this.persistSecret(conn);
    this.saveIndex({ id, serverUrl, userId, name });
    await this.relogin(conn);
    this.saveIndex({ id, serverUrl, userId, name: this.servers.find((s) => s.id === id)?.userName ?? name });
    await this.refreshSpaces(id);
    this.connectSocket(conn);
    this.patchServer(id, { status: 'online' });
    if (this.phase !== 'main') this.phase = 'main';
    this.selectFirstAvailable();
  }

  /** Disconnect, forget, and wipe credentials for a server. */
  async removeServer(serverId: string) {
    if (this.call?.serverId === serverId) this.leaveCall();
    const conn = this.conn(serverId);
    conn?.socket?.close();
    this.conns.delete(serverId);

    this.servers = this.servers.filter((s) => s.id !== serverId);
    delete this.spaces[serverId];
    for (const key of Object.keys(this.members)) if (key.startsWith(serverId + '|')) delete this.members[key];
    for (const key of Object.keys(this.messages)) if (key.startsWith(serverId + '|')) delete this.messages[key];
    for (const key of Object.keys(this.lockedSpaces)) if (key.startsWith(serverId + '|')) delete this.lockedSpaces[key];

    credentials.saveVault(credentials.loadVault().filter((a) => a.id !== serverId));
    await credentials.deleteSecret(serverId);

    if (this.activeServerId === serverId) {
      this.activeServerId = null;
      this.activeSpaceId = null;
      this.activeChannelId = null;
      this.selectFirstAvailable();
    }
    if (this.servers.length === 0) this.phase = 'onboarding';
  }

  // ---------- realtime ----------

  private connectSocket(conn: ServerConn) {
    if (!conn.api.token) return;
    conn.socket?.close();
    conn.socket = new EventSocket(conn.serverUrl, conn.api.token);
    conn.socket.onEvent((ev) => void this.handleEvent(conn.id, ev));
    conn.socket.connect();
  }

  private async handleEvent(serverId: string, ev: ServerEvent) {
    switch (ev.type) {
      case 'message_new': {
        const msg = await this.decryptWire(serverId, ev.channel_id, ev.message);
        const key = ck(serverId, ev.channel_id);
        const list = this.messages[key];
        if (list && !list.some((m) => m.id === msg.id)) list.push(msg);
        break;
      }
      case 'channel_created': {
        const space = this.spaces[serverId]?.find((s) => s.id === ev.space_id);
        if (space && !space.channels.some((c) => c.id === ev.channel.id)) {
          space.channels.push(ev.channel);
        }
        break;
      }
      case 'member_joined':
        await this.refreshMembers(serverId, ev.space_id);
        break;
      case 'member_removed':
        if (ev.user_id === this.userIdOf(serverId)) {
          this.spaces[serverId] = (this.spaces[serverId] ?? []).filter((s) => s.id !== ev.space_id);
          this.conn(serverId)?.spaceKeys.delete(ev.space_id);
          if (this.activeServerId === serverId && this.activeSpaceId === ev.space_id) {
            this.activeSpaceId = null;
            this.activeChannelId = null;
          }
        } else {
          await this.refreshMembers(serverId, ev.space_id);
        }
        break;
      case 'key_request':
        await this.wrapKeysFor(serverId, ev.space_id, ev.user.user_id, ev.user.kem_pub);
        break;
      case 'keys_updated':
        await this.loadSpaceKeys(serverId, ev.space_id);
        break;
    }
  }

  // ---------- spaces & members ----------

  async refreshSpaces(serverId: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    this.spaces[serverId] = (await conn.api.listSpaces()).spaces;
    await Promise.all(
      this.spaces[serverId].map((s) =>
        Promise.all([this.refreshMembers(serverId, s.id), this.loadSpaceKeys(serverId, s.id)]),
      ),
    );
  }

  async refreshMembers(serverId: string, spaceId: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    this.members[ck(serverId, spaceId)] = (await conn.api.listMembers(spaceId)).members;
  }

  async createSpace(serverId: string, name: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const space = await conn.api.createSpace(name);
    // Generate epoch 1 and store our own wrap so other devices/members can follow.
    const key = generateSpaceKey();
    await conn.api.uploadKeys(space.id, 1, [
      { user_id: conn.userId, wrapped: sealBox(conn.identity.kemPub, key) },
    ]);
    conn.spaceKeys.set(space.id, new Map([[1, key]]));
    await this.refreshSpaces(serverId);
    await this.selectChannel(serverId, space.id, space.channels[0]?.id ?? null);
  }

  async acceptInvite(serverId: string, token: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const space = await conn.api.acceptInvite(token.trim());
    await this.refreshSpaces(serverId);
    await this.selectChannel(serverId, space.id, space.channels[0]?.id ?? null);
  }

  async createInvite(serverId: string, spaceId: string): Promise<string> {
    const conn = this.conn(serverId);
    if (!conn) throw new Error('server not connected');
    const { token } = await conn.api.createInvite(spaceId);
    return token;
  }

  async createChannel(serverId: string, spaceId: string, name: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    await conn.api.createChannel(spaceId, name);
    await this.refreshSpaces(serverId);
  }

  async removeMember(serverId: string, spaceId: string, userId: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    await conn.api.removeMember(spaceId, userId);
    await this.refreshMembers(serverId, spaceId);
    // Rotate the space key so the removed member can't read new messages.
    const space = this.spaces[serverId]?.find((s) => s.id === spaceId);
    const remaining = this.membersOf(serverId, spaceId);
    if (!space) return;
    const newEpoch = space.current_epoch + 1;
    const key = generateSpaceKey();
    await conn.api.uploadKeys(
      spaceId,
      newEpoch,
      remaining.map((m) => ({ user_id: m.user_id, wrapped: sealBox(unb64u(m.kem_pub), key) })),
    );
    space.current_epoch = newEpoch;
    conn.spaceKeys.get(spaceId)?.set(newEpoch, key);
  }

  // ---------- keys ----------

  private async loadSpaceKeys(serverId: string, spaceId: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const { current_epoch, wraps } = await conn.api.fetchKeys(spaceId);
    const map = conn.spaceKeys.get(spaceId) ?? new Map<number, Uint8Array>();
    for (const w of wraps) {
      if (map.has(w.epoch)) continue;
      try {
        map.set(w.epoch, openBox(conn.identity, w.wrapped));
      } catch (e) {
        console.warn(`failed to unwrap key epoch ${w.epoch} for space ${spaceId}`, e);
      }
    }
    conn.spaceKeys.set(spaceId, map);
    const space = this.spaces[serverId]?.find((s) => s.id === spaceId);
    if (space) space.current_epoch = current_epoch;
    this.lockedSpaces[ck(serverId, spaceId)] = !map.has(current_epoch);
  }

  private async wrapKeysFor(serverId: string, spaceId: string, userId: string, kemPubB64: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const keys = conn.spaceKeys.get(spaceId);
    if (!keys || keys.size === 0) return;
    const kemPub = unb64u(kemPubB64);
    for (const [epoch, key] of keys) {
      // First-wrap-wins on the server, so concurrent members racing is fine.
      await conn.api
        .uploadKeys(spaceId, epoch, [{ user_id: userId, wrapped: sealBox(kemPub, key) }])
        .catch((e) => console.warn('key wrap upload failed', e));
    }
  }

  // ---------- messages ----------

  async selectChannel(serverId: string, spaceId: string, channelId: string | null) {
    this.activeServerId = serverId;
    this.activeSpaceId = spaceId;
    this.activeChannelId = channelId;
    if (channelId && !this.messages[ck(serverId, channelId)]) {
      await this.loadHistory(serverId, channelId);
    }
  }

  private spaceOfChannel(serverId: string, channelId: string): Space | null {
    return this.spaces[serverId]?.find((s) => s.channels.some((c) => c.id === channelId)) ?? null;
  }

  private async decryptWire(serverId: string, channelId: string, wire: WireMessage): Promise<ChatMessage> {
    const conn = this.conn(serverId);
    const space = this.spaceOfChannel(serverId, channelId);
    const base = {
      id: wire.id,
      senderId: wire.sender_id,
      senderName: space ? this.memberName(serverId, space.id, wire.sender_id) : wire.sender_id,
      createdAt: wire.created_at,
    };
    if (!space || !conn) return { ...base, body: '[unknown space]', ok: false };
    const key = conn.spaceKeys.get(space.id)?.get(wire.epoch);
    const pub = this.signPubOf(serverId, space.id, wire.sender_id);
    if (!key || !pub) return { ...base, body: '[no key for this message]', ok: false };
    try {
      const body = decryptMessage(pub, key, {
        spaceId: space.id,
        channelId,
        epoch: wire.epoch,
        senderId: wire.sender_id,
      }, wire) as { t: string; body: string };
      return { ...base, body: body.t === 'text' ? body.body : `[${body.t}]`, ok: true };
    } catch {
      return { ...base, body: '[failed to decrypt]', ok: false };
    }
  }

  async loadHistory(serverId: string, channelId: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const { messages } = await conn.api.fetchMessages(channelId);
    const decrypted = await Promise.all(messages.map((m) => this.decryptWire(serverId, channelId, m)));
    this.messages[ck(serverId, channelId)] = decrypted.reverse();
  }

  async sendMessage(serverId: string, channelId: string, text: string) {
    const conn = this.conn(serverId);
    if (!conn) return;
    const space = this.spaceOfChannel(serverId, channelId);
    if (!space) return;
    const key = conn.spaceKeys.get(space.id)?.get(space.current_epoch);
    if (!key) {
      this.error = 'Waiting for another member to share the space key.';
      return;
    }
    const enc = encryptMessage(conn.identity, key, {
      spaceId: space.id,
      channelId,
      epoch: space.current_epoch,
      senderId: conn.userId,
    }, { t: 'text', body: text });
    await conn.api.postMessage(channelId, { epoch: space.current_epoch, ...enc });
  }

  // ---------- identity backup ----------

  /** Identity backup the user can save to move devices (docs/CRYPTO.md). */
  exportIdentity(serverId: string): string {
    const conn = this.conn(serverId);
    if (!conn) throw new Error('server not connected');
    return JSON.stringify({
      user_id: conn.userId,
      server: conn.serverUrl,
      identity: JSON.parse(serializeIdentity(conn.identity)),
    });
  }

  // ---------- calls ----------

  async joinCall(serverId: string, channelId: string) {
    const conn = this.conn(serverId);
    if (!conn || !conn.socket) return;
    if (this.call) this.leaveCall();
    const space = this.spaceOfChannel(serverId, channelId);
    if (!space) return;

    const turn = await conn.api.turnCredentials();
    const iceServers: RTCIceServer[] = turn.username
      ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }]
      : [{ urls: turn.urls }];

    const manager = new CallManager(
      conn.socket,
      conn.identity,
      conn.userId,
      space.id,
      channelId,
      (userId) => this.signPubOf(serverId, space.id, userId),
      iceServers,
      {
        onPeersChanged: (participants) => {
          if (this.call) this.call.participants = participants;
        },
        onRemoteStreams: (userId, streams) => {
          if (!this.call) return;
          if (streams.length === 0) delete this.call.remoteStreams[userId];
          else this.call.remoteStreams[userId] = streams;
        },
        onStats: (stats) => {
          if (this.call) this.call.stats = Object.fromEntries(stats);
        },
        onBroadcastChanged: (broadcasting) => {
          if (this.call) this.call.broadcasting = broadcasting;
        },
        onEnded: () => {
          this.call = null;
        },
      },
    );
    manager.settings = this.broadcastSettings;
    this.call = {
      serverId,
      selfId: conn.userId,
      channelId,
      spaceId: space.id,
      manager,
      participants: [conn.userId],
      remoteStreams: {},
      stats: {},
      micMuted: false,
      broadcasting: false,
    };
    try {
      await manager.join();
    } catch (e) {
      this.call = null;
      this.error = `Could not join call: ${e instanceof Error ? e.message : e}`;
    }
  }

  leaveCall() {
    this.call?.manager.leave();
    this.call = null;
  }

  toggleMic() {
    if (!this.call) return;
    this.call.micMuted = !this.call.micMuted;
    this.call.manager.setMicMuted(this.call.micMuted);
  }

  async toggleBroadcast() {
    if (!this.call) return;
    if (this.call.broadcasting) {
      this.call.manager.stopBroadcast();
      this.call.broadcasting = false;
    } else {
      this.call.manager.settings = { ...this.broadcastSettings };
      await this.call.manager.startBroadcast();
      this.call.broadcasting = true;
    }
  }

  async applyBroadcastSettings() {
    if (!this.call) return;
    this.call.manager.settings = { ...this.broadcastSettings };
    await this.call.manager.applySenderSettings();
  }
}

export const store = new AppStore();
