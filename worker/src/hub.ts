// The online hub (WebSocket endpoint /multiplayer): replaces RoomHub.cs + EffectRunner + SweepService.
//
// One Durable Object holds every room (like the single RoomRegistry). WebSockets are accepted with
// the standard API (not hibernation) so the in-memory state lives as long as somebody is connected;
// rooms die when their last member leaves anyway, exactly like on Render.
//
// ── Wire protocol (replaces SignalR; every message is a JSON text frame) ─────
// client → server
//   {"type":"invoke","id":7,"method":"JoinRoom","args":[{...}]}   id optional: no id = no reply
//   {"type":"keepalive"}                                          at least every 30 s
//   {"type":"frag","fid":"a1","i":0,"n":3,"data":"..."}           a big message split in parts:
//                                                                  concatenate data (i = 0..n-1), parse
// server → client
//   {"type":"result","id":7,"result":{...}}  or  {"type":"result","id":7,"error":"..."}
//   {"type":"event","method":"RoomState","payload":{...}}
//   {"type":"ping"}                                               every 10 s (the client may ignore it)
//   {"type":"frag",...}                                           same format, for messages > ~384 KB
// Method names, arguments and payloads are the old hub's (camelCase; any casing accepted).

import { DurableObject } from "cloudflare:workers";
import { type Env, leaderboardStub, registryOptions } from "./env";
import { findOfficialByHash, loadOfficialLevels } from "./official";
import { Protocol, normalizeKeys, str, int, bool, num } from "./protocol";
import {
  Effects,
  RoomRegistry,
  sanitizeState,
  newId,
  type ChunkTicket,
  type CompleteTicket,
  type DownloadTicket,
  type RegistryStats,
  type Ticket,
  type UploadTicket,
} from "./registry";

const SWEEP_MS = 250;
const SERVER_PING_MS = 10_000;
/** Same as SignalR's ClientTimeoutInterval on the old server. */
const CLIENT_TIMEOUT_MS = 90_000;
const FRAG_CHARS = 384 * 1024;
const MAX_INCOMING_CHARS = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 128;

interface Conn {
  id: string;
  ws: WebSocket;
  lastReceived: number;
  frags: Map<string, { n: number; parts: (string | undefined)[]; received: number; chars: number }>;
}

type Args = unknown[];

export class Hub extends DurableObject<Env> {
  private readonly registry: RoomRegistry;
  private readonly conns = new Map<string, Conn>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastServerPing = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.registry = new RoomRegistry(registryOptions(env), () => Date.now(), findOfficialByHash);
    // Warm the official level list (SelectSong needs it synchronously).
    ctx.waitUntil(loadOfficialLevels(env.BUCKET).then(() => undefined));
  }

  // ══════════════════════════════════════════════════════════════════════
  // WebSocket
  // ══════════════════════════════════════════════════════════════════════

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket upgrade.", { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const conn: Conn = { id: newId(12), ws: server, lastReceived: Date.now(), frags: new Map() };
    this.conns.set(conn.id, conn);

    server.addEventListener("message", (ev) => {
      this.onMessage(conn, ev.data).catch((e) => console.log(`[Hub] message error: ${(e as Error).stack ?? e}`));
    });
    const closed = () => this.onClosed(conn);
    server.addEventListener("close", closed);
    server.addEventListener("error", closed);

    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  private onClosed(conn: Conn): void {
    if (!this.conns.delete(conn.id)) return;
    try {
      conn.ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
    this.run((fx) => this.registry.disconnect(conn.id, fx));
  }

  private async onMessage(conn: Conn, data: string | ArrayBuffer): Promise<void> {
    conn.lastReceived = Date.now();
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (text.length > MAX_INCOMING_CHARS) {
      conn.ws.close(1009, "Message too big.");
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const type = str(msg.type);

    if (type === "frag") {
      const full = this.collectFragment(conn, msg);
      if (full === null) return;
      try {
        msg = JSON.parse(full);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
    }

    if (str(msg.type) !== "invoke") return; // keepalive / pong / unknown: lastReceived is all we need

    const id = msg.id ?? null;
    const method = str(msg.method);
    const args = Array.isArray(msg.args) ? (msg.args.map(normalizeKeys) as Args) : [];
    try {
      const result = await this.dispatch(conn, method, args);
      if (id !== null) this.sendRaw(conn, JSON.stringify({ type: "result", id, result: result ?? null }));
    } catch (e) {
      const error = e instanceof HubError ? e.message : "Server error.";
      if (!(e instanceof HubError)) console.log(`[Hub] ${method} failed: ${(e as Error).stack ?? e}`);
      if (id !== null) this.sendRaw(conn, JSON.stringify({ type: "result", id, error }));
    }
  }

  private collectFragment(conn: Conn, msg: Record<string, unknown>): string | null {
    const fid = str(msg.fid);
    const i = int(msg.i, -1);
    const n = int(msg.n, 0);
    const data = str(msg.data);
    if (!fid || n < 1 || n > MAX_FRAGMENTS || i < 0 || i >= n) return null;
    let entry = conn.frags.get(fid);
    if (!entry) {
      if (conn.frags.size >= 4) conn.frags.clear(); // abandoned partial messages
      entry = { n, parts: new Array<string | undefined>(n).fill(undefined), received: 0, chars: 0 };
      conn.frags.set(fid, entry);
    }
    if (entry.n !== n) return null;
    if (entry.parts[i] === undefined) {
      entry.received++;
      entry.chars += data.length;
    }
    entry.parts[i] = data;
    if (entry.chars > MAX_INCOMING_CHARS) {
      conn.frags.delete(fid);
      return null;
    }
    if (entry.received < entry.n) return null;
    conn.frags.delete(fid);
    return entry.parts.join("");
  }

  private sendRaw(conn: Conn, text: string): void {
    try {
      if (text.length <= FRAG_CHARS) {
        conn.ws.send(text);
        return;
      }
      const fid = newId(6);
      const n = Math.ceil(text.length / FRAG_CHARS);
      for (let i = 0; i < n; i++)
        conn.ws.send(JSON.stringify({ type: "frag", fid, i, n, data: text.slice(i * FRAG_CHARS, (i + 1) * FRAG_CHARS) }));
    } catch {
      // Socket closing; the close handler cleans up.
    }
  }

  private sendEvent(connectionId: string, method: string, payload: unknown): void {
    const conn = this.conns.get(connectionId);
    if (conn) this.sendRaw(conn, JSON.stringify({ type: "event", method, payload }));
  }

  // ══════════════════════════════════════════════════════════════════════
  // Hub methods
  // ══════════════════════════════════════════════════════════════════════

  private async dispatch(conn: Conn, method: string, args: Args): Promise<unknown> {
    const c = conn.id;
    const r = this.registry;
    const a0 = args[0] as Record<string, unknown> | undefined;
    switch (method) {
      // Session
      case "Hello": {
        const result = this.run((fx) => r.hello(c, (a0 ?? {}) as never, fx));
        const profile = r.profileOf(c);
        if (result.ok && profile) {
          leaderboardStub(this.env)
            .upsertConnectedProfile({ ...profile, clientVersion: str(a0?.clientVersion) })
            .catch((e) => console.log(`[Hub] profile upsert failed: ${e}`));
        }
        return result;
      }
      case "Ping": {
        this.sendEvent(c, Protocol.Pong, r.ping(c, num(a0?.clientTimestamp)));
        return null;
      }

      // Rooms
      case "ListRooms":
        return r.listRooms();
      case "CreateRoom":
        return this.run((fx) => r.createRoom(c, (a0 ?? {}) as never, fx));
      case "JoinRoom":
        return this.run((fx) => r.joinRoom(c, (a0 ?? {}) as never, fx));
      case "LeaveRoom":
        return this.run((fx) => r.leaveRoom(c, fx));
      case "UpdateLevels":
        return this.run((fx) => r.updateLevels(c, args[0], fx));
      case "UpdateSettings":
        return this.run((fx) => r.updateSettings(c, (a0 ?? {}) as never, fx));
      case "Kick":
        return this.run((fx) => r.kick(c, str(args[0]), fx));
      case "SendChat":
        return this.run((fx) => r.chat(c, args[0], fx));
      case "SetSpectate":
        return this.run((fx) => r.setSpectate(c, bool(args[0]), fx));

      // Round
      case "SelectSong":
        if (str(a0?.source) === Protocol.SourceOfficial) await loadOfficialLevels(this.env.BUCKET);
        return this.run((fx) => r.selectSong(c, (a0 ?? {}) as never, fx));
      case "SetReady":
        return this.run((fx) => r.setReady(c, bool(args[0]), fx));
      case "SetLevelStatus":
        return this.run((fx) => r.setLevelStatus(c, (a0 ?? {}) as never, fx));
      case "VoteSide":
        return this.run((fx) => r.voteSide(c, int(args[0], -1), fx));
      case "CompleteDownload":
        return this.run((fx) =>
          r.completeDownload(c, str(args[0]), bool(args[1]), typeof args[2] === "string" ? args[2] : null, fx),
        );

      // Match
      case "MatchLoaded":
        return this.run((fx) => r.matchLoaded(c, str(args[0]), fx));
      case "SendState": {
        if (!a0) return null;
        const state = sanitizeState(a0 as never);
        r.recordState(c, state);
        this.relay(c, Protocol.PlayerState, { ...state });
        return null;
      }
      case "SendHit":
        if (a0) this.relay(c, Protocol.PlayerHit, { ...a0 });
        return null;
      case "SendKeyPress":
        if (a0) this.relay(c, Protocol.PlayerKeyPress, { ...a0 });
        return null;
      case "FinishMatch":
        return this.run((fx) => r.finishMatch(c, (a0 ?? {}) as never, fx));

      // Leaderboard (same packets as the old game server)
      case "GetLeaderboard": {
        const skip = Math.max(0, int(a0?.skip, 0));
        const take = Math.min(200, Math.max(1, int(a0?.take, 100)));
        const page = await leaderboardStub(this.env).topPlayers(skip, take);
        this.sendEvent(c, "LeaderboardResponse", { entries: page.entries, totalPlayers: page.total, timestamp: Date.now() });
        return null;
      }
      case "GetMatchHistory": {
        const skip = Math.max(0, int(a0?.skip, 0));
        const take = Math.min(200, Math.max(1, int(a0?.take, 50)));
        const playerId = typeof a0?.playerId === "string" ? a0.playerId : null;
        const page = await leaderboardStub(this.env).recentMatches(playerId, skip, take);
        this.sendEvent(c, "MatchHistoryResponse", { matches: page.matches, totalMatches: page.total, timestamp: Date.now() });
        return null;
      }

      default:
        throw new HubError(`Unknown method '${method}'.`);
    }
  }

  private relay(connectionId: string, method: string, packet: Record<string, unknown>): void {
    const target = this.registry.relay(connectionId);
    if (!target || target.targets.length === 0) return;
    packet.playerId = target.playerId;
    const text = JSON.stringify({ type: "event", method, payload: packet });
    for (const t of target.targets) {
      const conn = this.conns.get(t);
      if (conn) this.sendRaw(conn, text);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Effects & timers
  // ══════════════════════════════════════════════════════════════════════

  /** Runs a registry call and its effects (messages, R2 cleanup, leaderboard). */
  private run<T>(action: (fx: Effects) => T): T {
    const fx = new Effects();
    const result = action(fx);
    this.runEffects(fx);
    return result;
  }

  private runEffects(fx: Effects): void {
    // Same payload object to many members (chat, MatchLoading...): serialize once.
    const cache = new Map<unknown, Map<string, string>>();
    for (const m of fx.messages) {
      const conn = this.conns.get(m.connectionId);
      if (!conn) continue;
      let byMethod = cache.get(m.payload);
      if (!byMethod) cache.set(m.payload, (byMethod = new Map()));
      let text = byMethod.get(m.method);
      if (text === undefined) {
        text = JSON.stringify({ type: "event", method: m.method, payload: m.payload });
        byMethod.set(m.method, text);
      }
      this.sendRaw(conn, text);
    }

    const bucket = this.env.BUCKET;
    if (fx.objectsToDelete.length > 0) {
      const keys = [...new Set(fx.objectsToDelete)];
      this.background(bucket.delete(keys), "delete objects");
    }
    for (const mp of fx.multipartsToAbort)
      this.background(bucket.resumeMultipartUpload(mp.key, mp.uploadId).abort(), "abort multipart");
    for (const round of fx.roundsToRecord)
      this.background(leaderboardStub(this.env).recordRound(round), `record round ${round.matchId}`);
  }

  private background(p: Promise<unknown>, what: string): void {
    this.ctx.waitUntil(p.then(() => undefined).catch((e) => console.log(`[Hub] ${what} failed: ${e}`)));
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), SWEEP_MS);
  }

  private tick(): void {
    try {
      this.run((fx) => this.registry.sweep(fx));

      const now = Date.now();
      if (now - this.lastServerPing >= SERVER_PING_MS) {
        this.lastServerPing = now;
        for (const conn of [...this.conns.values()]) {
          if (now - conn.lastReceived > CLIENT_TIMEOUT_MS) {
            this.onClosed(conn); // the game stopped answering
            continue;
          }
          this.sendRaw(conn, '{"type":"ping"}');
        }
      }

      if (this.conns.size === 0 && !this.registry.hasActivity() && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    } catch (e) {
      console.log(`[Hub] sweep failed: ${(e as Error).stack ?? e}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // RPC for the HTTP transfer endpoints (transfers.ts)
  // ══════════════════════════════════════════════════════════════════════

  async stats(): Promise<{ stats: RegistryStats; maxUploadBytes: number }> {
    return { stats: this.registry.getStats(), maxUploadBytes: this.registry.maxUploadBytes };
  }

  async beginUpload(transferId: string, token: string): Promise<Ticket<UploadTicket>> {
    return this.registry.beginUpload(transferId, token);
  }

  async completeUpload(transferId: string, key: string, hash: string, size: number): Promise<{ ok: boolean; error: string }> {
    return this.run((fx) => this.registry.completeUpload(transferId, key, hash, size, fx));
  }

  async failUpload(transferId: string, reason: string, key: string | null): Promise<void> {
    this.run((fx) => this.registry.failUpload(transferId, reason, key, fx));
  }

  async reportUploadBytes(transferId: string, bytes: number): Promise<void> {
    this.run((fx) => this.registry.reportUploadBytes(transferId, bytes, fx));
  }

  async beginChunkUpload(transferId: string, token: string, offset: number, length: number): Promise<Ticket<ChunkTicket>> {
    const res = this.registry.beginChunkUpload(transferId, token, offset, length);
    if (!res.ok || res.ticket.uploadId) return res;
    // First chunk: start the R2 multipart upload (chunkWriteInFlight already blocks other chunks).
    try {
      const mp = await this.env.BUCKET.createMultipartUpload(res.ticket.key, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (!this.registry.setMultipartUploadId(transferId, res.ticket.key, mp.uploadId)) {
        this.background(mp.abort(), "abort multipart");
        return { ok: false, error: "The transfer was cancelled." };
      }
      return { ok: true, ticket: { ...res.ticket, uploadId: mp.uploadId } };
    } catch (e) {
      this.registry.abortChunkWrite(transferId);
      console.log(`[Hub] createMultipartUpload failed: ${e}`);
      return { ok: false, error: "Could not start the upload; retry." };
    }
  }

  async finishChunkUpload(transferId: string, partNumber: number, etag: string, size: number): Promise<void> {
    this.run((fx) => this.registry.finishChunkUpload(transferId, partNumber, etag, size, fx));
  }

  async abortChunkWrite(transferId: string): Promise<void> {
    this.registry.abortChunkWrite(transferId);
  }

  async beginCompleteChunkedUpload(transferId: string, token: string): Promise<Ticket<CompleteTicket>> {
    return this.registry.beginCompleteChunkedUpload(transferId, token);
  }

  async beginDownload(transferId: string, token: string): Promise<Ticket<DownloadTicket>> {
    return this.registry.beginDownload(transferId, token);
  }

  async reportDownloadBytes(transferId: string, token: string, bytes: number): Promise<boolean> {
    return this.run((fx) => this.registry.reportDownloadBytes(transferId, token, bytes, fx));
  }

  async markDownloadStreamComplete(transferId: string, token: string): Promise<void> {
    this.registry.markDownloadStreamComplete(transferId, token);
  }
}

class HubError extends Error {}
