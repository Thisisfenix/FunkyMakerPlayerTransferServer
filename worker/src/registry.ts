// Port of src/FunkyMakerTransferServer/RoomRegistry.cs. Pure logic (no Cloudflare APIs) so it can be
// unit-tested: the Hub Durable Object owns one instance, calls it synchronously (a Durable Object is
// single-threaded, which replaces the C# lock) and runs the collected Effects afterwards.
//
// Differences from the C# server:
// - Level files live in R2 (object keys instead of file paths). Chunked uploads are R2 multipart
//   uploads: chunk at offset N is part N / chunkBytes + 1.
// - The Worker cannot hash big files (10 ms CPU limit): exact FNF files are checked by R2 on single
//   PUTs (sha256 option) and by the downloaders; packed variants report their hash (X-File-Hash).
// - HTTP streams cannot be cancelled from here: download progress calls return false once the
//   download was dropped, and the Worker aborts the stream.

import {
  Protocol,
  OpResult,
  type ChatMessage,
  type CreateRoomRequest,
  type FinishMatchRequest,
  type HelloRequest,
  type HelloResult,
  type JoinRoomRequest,
  type LevelEntry,
  type LevelStatusUpdate,
  type MatchInfo,
  type PlayerResult,
  type PlayerStatePacket,
  type PongPacket,
  type RoomLevel,
  type RoomMember,
  type RoomSettings,
  type RoomStatePacket,
  type RoomSummary,
  type RoundResult,
  type SongInfo,
  type SongSelection,
  str,
  num,
  int,
  bool,
} from "./protocol";

export interface Outbound {
  connectionId: string;
  method: string;
  payload: unknown;
}

export interface MultipartRef {
  key: string;
  uploadId: string;
}

/** Side effects collected during a registry call and run by the Hub afterwards. */
export class Effects {
  messages: Outbound[] = [];
  objectsToDelete: string[] = [];
  multipartsToAbort: MultipartRef[] = [];
  roundsToRecord: RoundResult[] = [];

  send(connectionId: string, method: string, payload: unknown): void {
    this.messages.push({ connectionId, method, payload });
  }
}

export interface OfficialLevel {
  id: string;
  name: string;
  fileName: string;
  hash: string;
  size: number;
}

export interface RegistryOptions {
  maxUploadMegabytes: number;
  maxRoomMembers: number;
  maxLevelsPerMember: number;
  stallTimeoutSeconds: number;
  downloadCompletionGraceSeconds: number;
  loadingTimeoutSeconds: number;
  cacheMinutes: number;
  progressIntervalMs: number;
  uploadChunkMegabytes: number;
  serverVersion: string;
}

export const defaultOptions: RegistryOptions = {
  maxUploadMegabytes: 250,
  maxRoomMembers: Protocol.MaxPlayers,
  maxLevelsPerMember: 5000,
  stallTimeoutSeconds: 300,
  downloadCompletionGraceSeconds: 600,
  loadingTimeoutSeconds: 180,
  cacheMinutes: 15,
  progressIntervalMs: 200,
  uploadChunkMegabytes: 6,
  serverVersion: "1.0.0-workers",
};

export interface RegistryStats {
  sessions: number;
  rooms: number;
  members: number;
  matches: number;
  transfers: number;
  cachedFiles: number;
}

// ── Tickets for the HTTP side ───────────────────────────────────────────────

export interface UploadTicket {
  transferId: string;
  key: string;
  hash: string;
  /** Exact size (fnf) or the most the upload may be (packed variants). */
  size: number;
  exactSize: boolean;
}

export interface ChunkTicket {
  transferId: string;
  key: string;
  /** Null on the first chunk: the Hub creates the multipart upload and calls setMultipartUploadId. */
  uploadId: string | null;
  partNumber: number;
  chunkBytes: number;
  maxSize: number;
  exactSize: boolean;
}

export interface CompleteTicket {
  transferId: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
  totalBytes: number;
  maxSize: number;
  exactSize: boolean;
  /** fnf exact files: the level hash; packed variants: "" (the uploader reports it). */
  expectedHash: string;
}

export interface DownloadTicket {
  transferId: string;
  key: string;
  size: number;
  fileName: string;
}

export type Ticket<T> = { ok: true; ticket: T } | { ok: false; error: string };

// ── State types ────────────────────────────────────────────────────────────

class Session {
  playerId = "";
  username = "Player";
  colorHue = 180;
  osuSkipVideo = false;
  fnfChartOnly = false;
  greeted = false;
  avgPing = 0;
  member: Member | null = null;
  constructor(readonly connectionId: string) {}
}

class Room {
  members: Member[] = [];
  phase: string = Protocol.PhaseLobby;
  turnSeq = 0;
  song: SongInfo | null = null;
  match: MatchState | null = null;
  history: RoundResult[] = [];
  chat: ChatMessage[] = [];
  bans = new Map<string, number>();
  cache = new Map<string, CachedFile>();
  lastProgressBroadcast = 0;
  progressDirty = false;
  levelsVersion = 1;
  historyVersion = 1;
  constructor(
    readonly id: string,
    readonly name: string,
    public settings: RoomSettings,
    readonly createdAt: number,
  ) {}
  get host(): Member | null {
    return this.members.length > 0 ? this.members[0] : null;
  }
  get turnMember(): Member | null {
    return this.members.find((m) => m.joinSeq === this.turnSeq) ?? null;
  }
}

class Member {
  levels = new Map<string, LevelEntry>();
  chartOnlyHashes = new Set<string>();
  ready = false;
  spectate = false;
  vote = -1;
  levelState: string = Protocol.LevelMissing;
  levelProgress = 0;
  uploadProgress = -1;
  lastChat = -Infinity;
  sentLevelsVersion = 0;
  sentHistoryVersion = 0;
  constructor(
    public session: Session,
    readonly room: Room,
    readonly joinSeq: number,
  ) {}
}

class MatchState {
  participants = new Map<string, Participant>();
  loaded = new Set<string>();
  firstFinishAt: number | null = null;
  names = new Map<string, string>();
  hues = new Map<string, number>();
  constructor(
    readonly info: MatchInfo,
    readonly createdAt: number,
  ) {}
}

class Participant {
  final: FinishMatchRequest | null = null;
  last: PlayerStatePacket | null = null;
  gone = false;
  lastSeen = 0;
  constructor(readonly assignment: { playerId: string; side: number; team: number }) {}
}

interface CachedFile {
  key: string;
  size: number;
  fileHash: string;
  expiresAt: number;
}

interface Download {
  playerId: string;
  token: string;
  bytes: number;
  streamCompleted: boolean;
  lastActivity: number;
}

class Transfer {
  entry!: LevelEntry;
  kind: string = Protocol.KindFnf;
  variant: string = Protocol.VariantFull;
  size = 0;
  estimatedSize = 0;
  fileHash = "";
  uploadStarted = false;
  uploadBytes = 0;
  /** Object key of the chunked upload in progress (multipart), null before the first chunk. */
  chunkKey: string | null = null;
  uploadId: string | null = null;
  parts = new Map<number, { etag: string; size: number }>();
  chunkBytesWritten = 0;
  chunkWriteInFlight = false;
  /** Single-PUT upload in progress. */
  putKey: string | null = null;
  lastActivity = 0;
  /** Set once the file is in R2 (uploaded or from the room cache). */
  objectKey: string | null = null;
  downloads = new Map<string, Download>();
  constructor(
    readonly id: string,
    readonly room: Room,
    readonly hash: string,
    readonly uploaderId: string,
    readonly uploadToken: string,
  ) {}
  get isPackedVariant(): boolean {
    return this.kind === Protocol.KindOsu || this.variant === Protocol.VariantChartOnly;
  }
  get cacheKey(): string {
    return cacheKeyOf(this.hash, this.variant);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

export const LoadingTimeoutMs = 180_000;
export const FinishGraceMs = 30_000;
export const KickBanMs = 5 * 60_000;
export const SilenceTimeoutMs = 10_000;
export const ChatIntervalMs = 300;
export const MaxChatHistory = 60;
export const MaxRoundHistory = 50;
export const CountdownMs = 4000;

const HashRegex = /^[0-9a-f]{64}$/;

function cacheKeyOf(hash: string, variant: string): string {
  return variant === Protocol.VariantFull ? hash : `${hash}:${variant}`;
}

// ══════════════════════════════════════════════════════════════════════════

export class RoomRegistry {
  private sessions = new Map<string, Session>();
  private rooms = new Map<string, Room>();
  private transfers = new Map<string, Transfer>();
  private joinSeq = 0;
  readonly options: RegistryOptions;

  /** Picks random values (team split, sides, ties). Tests replace it for determinism. */
  randomInt: (max: number) => number = (max) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  };

  constructor(
    options: Partial<RegistryOptions> = {},
    private readonly clock: () => number = () => Date.now(),
    private readonly findOfficial: (hash: string) => OfficialLevel | null = () => null,
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  get maxUploadBytes(): number {
    return this.options.maxUploadMegabytes * 1024 * 1024;
  }

  get maxRoomPlayers(): number {
    return clamp(this.options.maxRoomMembers, Protocol.MinPlayers, Protocol.HardMaxPlayers);
  }

  /** R2 multipart parts must be >= 5 MiB (except the last) and all the same size. */
  get uploadChunkBytes(): number {
    return clamp(this.options.uploadChunkMegabytes, 5, 16) * 1024 * 1024;
  }

  private get now(): number {
    return this.clock();
  }

  hasActivity(): boolean {
    return this.sessions.size > 0 || this.rooms.size > 0 || this.transfers.size > 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Sessions
  // ══════════════════════════════════════════════════════════════════════

  hello(connectionId: string, raw: Partial<HelloRequest>, fx: Effects): HelloResult {
    const request = raw ?? {};
    const protocolVersion = int(request.protocolVersion);
    const base: HelloResult = {
      ok: false,
      error: "",
      protocolVersion: Protocol.Version,
      serverVersion: this.options.serverVersion,
      maxUploadBytes: 0,
      maxRoomPlayers: Protocol.MaxPlayers,
      supportsChunkedUpload: false,
      supportsFnfChartOnly: false,
      uploadChunkBytes: 0,
    };
    if (protocolVersion !== Protocol.Version) {
      return {
        ...base,
        error: `Online protocol mismatch (server ${Protocol.Version}, game ${protocolVersion}). Update the game.`,
      };
    }

    let playerId = clean(str(request.playerId), 64);
    if (playerId.length === 0) playerId = "conn-" + connectionId;
    let s = this.sessions.get(connectionId);
    if (!s) {
      s = new Session(connectionId);
      this.sessions.set(connectionId, s);
    }
    const osuSkipVideo = bool(request.osuSkipVideo);
    const fnfChartOnly = bool(request.fnfChartOnly);
    const variantPrefChanged = s.osuSkipVideo !== osuSkipVideo || s.fnfChartOnly !== fnfChartOnly;
    s.playerId = playerId;
    s.username = cleanName(str(request.username), "Player");
    s.colorHue = clamp(int(request.colorHue, 180), 0, 360);
    s.osuSkipVideo = osuSkipVideo;
    s.fnfChartOnly = fnfChartOnly;
    s.greeted = true;
    if (s.member) {
      if (variantPrefChanged) {
        for (const tr of this.transfers.values()) {
          if (tr.room === s.member.room) tr.downloads.delete(s.playerId);
        }
        this.updateMemberLevelState(s.member);
        if (s.member.levelState === Protocol.LevelMissing) this.offerDownload(s.member.room, s.member, fx);
        this.tryAdvanceRound(s.member.room, fx);
      }
      this.broadcastRoom(s.member.room, fx);
    }
    return {
      ...base,
      ok: true,
      maxUploadBytes: this.maxUploadBytes,
      maxRoomPlayers: this.maxRoomPlayers,
      supportsChunkedUpload: true,
      supportsFnfChartOnly: true,
      uploadChunkBytes: this.uploadChunkBytes,
    };
  }

  /** The session's player id/name/hue after a successful Hello (for the leaderboard's user directory). */
  profileOf(connectionId: string): { playerId: string; username: string; colorHue: number } | null {
    const s = this.sessions.get(connectionId);
    return s && s.greeted ? { playerId: s.playerId, username: s.username, colorHue: s.colorHue } : null;
  }

  ping(connectionId: string, clientTimestamp: number): PongPacket {
    const now = this.now;
    const sample = Math.trunc(clamp(now - clientTimestamp, 0, 5000));
    const s = this.sessions.get(connectionId);
    if (s) s.avgPing = s.avgPing <= 0 ? sample : s.avgPing * 0.7 + sample * 0.3;
    return { clientTimestamp, serverTimestamp: now, ping: sample };
  }

  disconnect(connectionId: string, fx: Effects): void {
    const s = this.sessions.get(connectionId);
    if (!s) return;
    if (s.member) this.removeMember(s.member, fx, `${s.username} disconnected.`);
    this.sessions.delete(connectionId);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Room browser
  // ══════════════════════════════════════════════════════════════════════

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        id: r.id,
        name: r.name,
        hasPassword: r.settings.password.length > 0,
        mode: r.settings.mode,
        phase: r.phase,
        songName: r.match ? r.match.info.song.name : "",
        songStars: r.match ? r.match.info.song.stars : 0,
        hostName: r.host?.session.username ?? "",
        players: r.members.map((m) => ({
          id: m.session.playerId,
          username: m.session.username,
          colorHue: m.session.colorHue,
        })),
        playerCount: r.members.length,
        maxPlayers: r.settings.maxPlayers,
      }));
  }

  createRoom(connectionId: string, raw: Partial<CreateRoomRequest>, fx: Effects): OpResult {
    const request = raw ?? {};
    const s = this.sessions.get(connectionId);
    if (!s || !s.greeted) return OpResult.fail("Not connected.");

    if (s.member) this.removeMember(s.member, fx, `${s.username} left.`);

    const res = this.sanitizeSettings(request.settings, Protocol.MinPlayers);
    if ("error" in res) return OpResult.fail(res.error);

    let name = clean(str(request.name), Protocol.MaxRoomNameLength);
    if (name.length === 0) name = clean(`${s.username}'s room`, Protocol.MaxRoomNameLength);

    const room = new Room(this.newRoomId(), name, res.settings, this.now);
    this.rooms.set(room.id, room);
    const member = this.addMember(room, s, request.levels);
    room.turnSeq = member.joinSeq;
    this.addSystemChat(room, `${s.username} created the room.`, fx);
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  joinRoom(connectionId: string, raw: Partial<JoinRoomRequest>, fx: Effects): OpResult {
    const request = raw ?? {};
    const roomId = str(request.roomId).trim().toUpperCase();
    const s = this.sessions.get(connectionId);
    if (!s || !s.greeted) return OpResult.fail("Not connected.");
    const room = this.rooms.get(roomId);
    if (!room) return OpResult.fail("That room doesn't exist any more.");
    if (s.member?.room === room) return OpResult.success(room.id);

    // Same player on a new connection (reconnect): take over their place in the room.
    const stale = room.members.find((m) => m.session.playerId === s.playerId);
    if (stale) {
      if (s.member) this.removeMember(s.member, fx, `${s.username} left.`);
      const old = stale.session;
      old.member = null;
      fx.send(old.connectionId, Protocol.Kicked, { reason: "You joined this room from another window." });
      this.sessions.delete(old.connectionId);
      stale.session = s;
      s.member = stale;
      stale.levels = this.sanitizeLevels(request.levels);
      stale.sentLevelsVersion = 0;
      stale.sentHistoryVersion = 0;
      room.levelsVersion++;
      this.updateMemberLevelState(stale);
      this.sendChatHistory(room, s, fx);
      this.broadcastRoom(room, fx);
      return OpResult.success(room.id);
    }

    const until = room.bans.get(s.playerId);
    if (until !== undefined && until > this.now) return OpResult.fail("You were kicked from this room. Try again later.");
    if (room.members.length >= room.settings.maxPlayers) return OpResult.fail("This room is full.");
    if (room.settings.password.length > 0 && !secretEquals(room.settings.password, str(request.password)))
      return OpResult.fail("Wrong password.");

    if (s.member) this.removeMember(s.member, fx, `${s.username} left.`);
    const member = this.addMember(room, s, request.levels);
    this.sendChatHistory(room, s, fx);
    this.addSystemChat(room, `${s.username} joined.`, fx);
    this.ensureTurn(room);
    this.offerDownload(room, member, fx);
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  leaveRoom(connectionId: string, fx: Effects): void {
    const s = this.sessions.get(connectionId);
    if (s?.member) this.removeMember(s.member, fx, `${s.username} left.`);
  }

  updateLevels(connectionId: string, levels: unknown, fx: Effects): void {
    const m = this.tryMember(connectionId);
    if (!m) return;
    m.levels = this.sanitizeLevels(levels);
    m.room.levelsVersion++;
    this.updateMemberLevelState(m);
    this.tryAdvanceRound(m.room, fx);
    this.broadcastRoom(m.room, fx);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Host tools
  // ══════════════════════════════════════════════════════════════════════

  updateSettings(connectionId: string, request: Partial<RoomSettings>, fx: Effects): OpResult {
    const m = this.tryMember(connectionId);
    if (!m) return OpResult.fail("You're not in a room.");
    const room = m.room;
    if (room.host !== m) return OpResult.fail("Only the host can change the room settings.");
    if (room.phase === Protocol.PhaseLoading || room.phase === Protocol.PhasePlaying)
      return OpResult.fail("Settings can only be changed between rounds.");

    const res = this.sanitizeSettings(request, Math.max(Protocol.MinPlayers, room.members.length));
    if ("error" in res) return OpResult.fail(res.error);
    const next = res.settings;

    const old = room.settings;
    const changes: string[] = [];
    if (old.mode !== next.mode) changes.push(`mode → ${modeName(next.mode)}`);
    if (old.songSelection !== next.songSelection) changes.push(`song selection → ${selectionName(next.songSelection)}`);
    if (old.maxPlayers !== next.maxPlayers) changes.push(`player limit → ${next.maxPlayers}`);
    if (old.password.length > 0 !== next.password.length > 0)
      changes.push(next.password.length > 0 ? "room is now password protected" : "room is now open");
    else if (old.password !== next.password) changes.push("password changed");
    if (old.allowGuestLocalLevels !== next.allowGuestLocalLevels)
      changes.push(
        next.allowGuestLocalLevels ? "guests may pick their local levels" : "guests may only pick official / host levels",
      );
    if (old.songTypes !== next.songTypes) changes.push(`song types → ${songTypesName(next.songTypes)}`);

    if (changes.length === 0) return OpResult.success(room.id);

    room.settings = next;
    room.levelsVersion++;
    this.addSystemChat(room, `Host changed the settings: ${changes.join(", ")}.`, fx);

    if (old.songSelection !== next.songSelection && next.songSelection === Protocol.SelectHost && room.host)
      room.turnSeq = room.host.joinSeq;
    this.ensureTurn(room);

    if (room.song) {
      const stillAllowed =
        room.song.source === Protocol.SourceOfficial
          ? kindAllowed(room, Protocol.KindFnf)
          : this.isPickable(room, room.song.hash);
      const chooserStillTurn = room.turnMember?.session.playerId === room.song.pickedBy;
      if (!stillAllowed || !chooserStillTurn) {
        this.clearSong(room, fx);
        this.addSystemChat(room, "The picked song was cleared by the new settings.", fx);
      } else if (old.mode !== next.mode) {
        this.resetReady(room, true);
      }
    }

    this.tryAdvanceRound(room, fx);
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  kick(connectionId: string, playerId: string, fx: Effects): OpResult {
    const m = this.tryMember(connectionId);
    if (!m) return OpResult.fail("You're not in a room.");
    const room = m.room;
    if (room.host !== m) return OpResult.fail("Only the host can kick players.");
    const target = room.members.find((x) => x.session.playerId === playerId);
    if (!target) return OpResult.fail("That player isn't in the room.");
    if (target === m) return OpResult.fail("You can't kick yourself.");

    room.bans.set(target.session.playerId, this.now + KickBanMs);
    fx.send(target.session.connectionId, Protocol.Kicked, { reason: "The host removed you from the room." });
    this.removeMember(target, fx, `${target.session.username} was kicked by the host.`);
    return OpResult.success(room.id);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Chat & player state in the waiting room
  // ══════════════════════════════════════════════════════════════════════

  chat(connectionId: string, text: unknown, fx: Effects): void {
    const m = this.tryMember(connectionId);
    if (!m) return;
    const cleaned = clean(str(text), Protocol.MaxChatLength);
    if (cleaned.length === 0) return;
    const now = this.now;
    if (now - m.lastChat < ChatIntervalMs) return;
    m.lastChat = now;
    this.addChat(
      m.room,
      {
        playerId: m.session.playerId,
        username: m.session.username,
        colorHue: m.session.colorHue,
        text: cleaned,
        system: false,
        timestamp: now,
      },
      fx,
    );
  }

  setSpectate(connectionId: string, spectate: boolean, fx: Effects): void {
    const m = this.tryMember(connectionId);
    if (!m || m.spectate === spectate) return;
    const room = m.room;
    m.spectate = spectate;
    m.ready = false;
    m.vote = -1;
    this.addSystemChat(room, spectate ? `${m.session.username} will spectate.` : `${m.session.username} will play.`, fx);

    if (
      spectate &&
      room.settings.songSelection === Protocol.SelectTurns &&
      room.turnMember === m &&
      (room.phase === Protocol.PhaseLobby || room.phase === Protocol.PhaseSongSelected)
    ) {
      if (room.song) this.clearSong(room, fx);
      this.advanceTurn(room);
      this.announceTurn(room, fx);
    } else {
      this.ensureTurn(room);
    }
    this.tryAdvanceRound(room, fx);
    this.broadcastRoom(room, fx);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Round: pick, ready, vote
  // ══════════════════════════════════════════════════════════════════════

  selectSong(connectionId: string, raw: Partial<SongSelection>, fx: Effects): OpResult {
    const selection = raw ?? {};
    const m = this.tryMember(connectionId);
    if (!m) return OpResult.fail("You're not in a room.");
    const room = m.room;
    if (room.phase !== Protocol.PhaseLobby && room.phase !== Protocol.PhaseSongSelected)
      return OpResult.fail("Wait for the current round to end.");
    this.ensureTurn(room);
    if (room.turnMember !== m) return OpResult.fail("It's not your turn to pick.");
    if (room.song) return OpResult.fail("A song was already picked for this round. It can't be changed.");

    const hash = str(selection.hash).trim().toLowerCase();
    if (!HashRegex.test(hash)) return OpResult.fail("Invalid level.");

    let song: SongInfo;
    const source = str(selection.source, Protocol.SourceOfficial);
    if (source === Protocol.SourceOfficial) {
      if (!kindAllowed(room, Protocol.KindFnf)) return OpResult.fail("This room only plays osu!mania songs.");
      const off = this.findOfficial(hash);
      if (!off) return OpResult.fail("That official level isn't on the server.");
      song = {
        ...emptySong(),
        source: Protocol.SourceOfficial,
        hash,
        name: off.name,
        fileName: off.fileName,
        size: off.size,
        officialId: off.id,
        kind: Protocol.KindFnf,
      };
    } else if (source === Protocol.SourceLocal) {
      let entry: LevelEntry | undefined;
      for (const x of room.members) {
        entry = x.levels.get(hash);
        if (entry) break;
      }
      if (!entry) return OpResult.fail("Nobody in the room has that level any more.");
      if (!kindAllowed(room, entry.kind))
        return OpResult.fail(
          entry.kind !== Protocol.KindOsu
            ? "This room only plays osu!mania songs."
            : room.settings.mode !== Protocol.ModeMirror
              ? "osu!mania songs can only be played in Mirror mode."
              : "This room doesn't play osu!mania songs.",
        );
      if (!this.isPickable(room, hash)) return OpResult.fail("This room only allows official levels and the host's levels.");
      song = {
        ...emptySong(),
        source: Protocol.SourceLocal,
        hash,
        name: entry.name,
        fileName: entry.fileName,
        size: entry.size,
        kind: entry.kind,
        setId: entry.setId,
        setName: entry.setName,
        difficulty: entry.difficulty,
        sizeNoVideo: entry.sizeNoVideo,
      };
    } else {
      return OpResult.fail("Unknown level source.");
    }

    song.stars = clamp(num(selection.stars), 0, 99);
    song.pickedBy = m.session.playerId;

    room.song = song;
    room.phase = Protocol.PhaseSongSelected;
    this.resetReady(room, false);
    m.ready = !m.spectate;
    for (const x of room.members) this.updateMemberLevelState(x);

    const stars = song.stars > 0 ? ` (★${song.stars.toFixed(1)})` : "";
    this.addSystemChat(room, `${m.session.username} picked ${song.name}${stars}.`, fx);

    if (song.source === Protocol.SourceLocal) this.startTransfer(room, fx);
    this.tryAdvanceRound(room, fx);
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  setReady(connectionId: string, ready: boolean, fx: Effects): OpResult {
    const m = this.tryMember(connectionId);
    if (!m) return OpResult.fail("You're not in a room.");
    const room = m.room;
    if (room.phase !== Protocol.PhaseSongSelected) return OpResult.fail("No song is waiting to start.");
    if (m.spectate) return OpResult.fail("Spectators don't need to be ready.");
    if (ready && m.levelState !== Protocol.LevelReady) return OpResult.fail("You don't have the level yet.");
    if (m.ready === ready) return OpResult.success(room.id);
    m.ready = ready;
    this.tryAdvanceRound(room, fx);
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  setLevelStatus(connectionId: string, raw: Partial<LevelStatusUpdate>, fx: Effects): void {
    const update = raw ?? {};
    const m = this.tryMember(connectionId);
    if (!m) return;
    const room = m.room;
    const song = room.song ?? room.match?.info.song ?? null;
    if (!song || song.hash.toLowerCase() !== str(update.hash).toLowerCase()) return;

    const requested = str(update.state);
    const state =
      requested === Protocol.LevelReady
        ? Protocol.LevelReady
        : requested === Protocol.LevelDownloading
          ? Protocol.LevelDownloading
          : requested === Protocol.LevelFailed
            ? Protocol.LevelFailed
            : Protocol.LevelMissing;
    if (state === Protocol.LevelReady && song.source === Protocol.SourceLocal) {
      if (song.kind === Protocol.KindFnf && m.session.fnfChartOnly && !m.levels.has(song.hash)) {
        m.chartOnlyHashes.add(song.hash);
      } else {
        if (!m.levels.has(song.hash)) {
          m.room.levelsVersion++;
          m.levels.set(song.hash, entryFor(song));
        }
      }
    }

    // The Worker streams downloads straight from R2 without counting bytes (CPU limit): the client's
    // own progress reports (every 5 %) keep its download alive for the stall timeout instead.
    const progress = clamp(num(update.progress), 0, 1);
    if (state === Protocol.LevelDownloading) {
      for (const t of this.roomTransfers(room)) {
        const d = t.hash === song.hash ? t.downloads.get(m.session.playerId) : undefined;
        if (!d) continue;
        d.lastActivity = this.now;
        d.bytes = Math.round(progress * t.size);
        if (progress >= 0.999) d.streamCompleted = true;
      }
    }

    const changed = m.levelState !== state;
    m.levelState = state;
    m.levelProgress = progress;
    if (state !== Protocol.LevelReady) m.ready = false;

    if (state === Protocol.LevelMissing && song.source === Protocol.SourceLocal) this.offerDownload(room, m, fx);

    if (changed) this.tryAdvanceRound(room, fx);
    if (changed || this.progressBroadcastDue(room)) this.broadcastRoom(room, fx);
  }

  voteSide(connectionId: string, side: number, fx: Effects): OpResult {
    const m = this.tryMember(connectionId);
    if (!m) return OpResult.fail("You're not in a room.");
    const room = m.room;
    if (room.settings.mode !== Protocol.ModeMirror) return OpResult.fail("Votes are only used in Mirror mode.");
    if (room.phase !== Protocol.PhaseSongSelected) return OpResult.fail("No song is waiting to start.");
    if (m.spectate) return OpResult.fail("Spectators don't vote.");
    m.vote = side === Protocol.SidePlayer || side === Protocol.SideEnemy ? side : -1;
    this.broadcastRoom(room, fx);
    return OpResult.success(room.id);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Match
  // ══════════════════════════════════════════════════════════════════════

  matchLoaded(connectionId: string, matchId: string, fx: Effects): void {
    const m = this.tryMember(connectionId);
    if (!m) return;
    const room = m.room;
    const match = room.match;
    if (!match || match.info.matchId !== matchId || room.phase !== Protocol.PhaseLoading) return;
    if (!match.participants.has(m.session.playerId)) return;
    if (!match.loaded.has(m.session.playerId)) {
      match.loaded.add(m.session.playerId);
      match.info.loaded = [...match.loaded];
    }
    this.tryStartMatch(room, fx);
    this.broadcastRoom(room, fx);
  }

  /** Relays an in-match packet: returns the sender's player id and the other members' connections. */
  relay(connectionId: string): { playerId: string; targets: string[] } | null {
    const m = this.tryMember(connectionId);
    if (!m) return null;
    const room = m.room;
    const p = room.match?.participants.get(m.session.playerId);
    if (!p || p.final) return null;
    p.lastSeen = this.now;
    const targets: string[] = [];
    for (const o of room.members) if (o !== m) targets.push(o.session.connectionId);
    return { playerId: m.session.playerId, targets };
  }

  recordState(connectionId: string, state: PlayerStatePacket): void {
    const m = this.tryMember(connectionId);
    if (!m || !m.room.match) return;
    const p = m.room.match.participants.get(m.session.playerId);
    if (p && !p.final) {
      p.last = state;
      p.lastSeen = this.now;
    }
  }

  finishMatch(connectionId: string, raw: Partial<FinishMatchRequest>, fx: Effects): void {
    const request = sanitizeFinish(raw);
    const m = this.tryMember(connectionId);
    if (!m) return;
    const room = m.room;
    const match = room.match;
    if (!match || match.info.matchId !== request.matchId) return;
    const p = match.participants.get(m.session.playerId);
    if (!p || p.final) return;

    if (room.phase === Protocol.PhaseLoading) {
      if (!request.quit) return;
      match.participants.delete(m.session.playerId);
      match.loaded.delete(m.session.playerId);
      match.info.loaded = [...match.loaded];
      this.addSystemChat(room, `${m.session.username} left the match.`, fx);
      if (!this.tryStartMatch(room, fx) && match.participants.size < minParticipants())
        this.cancelMatch(room, fx, "Not enough players left. Round cancelled.");
      else this.broadcastRoom(room, fx);
      return;
    }
    if (room.phase !== Protocol.PhasePlaying) return;

    if (request.sicks + request.goods + request.bads + request.shits + request.misses === 0) request.accuracy = 0;
    p.final = request;
    if (request.quit) {
      p.gone = true;
      this.addSystemChat(room, `${m.session.username} left the match.`, fx);
    } else {
      match.firstFinishAt ??= this.now;
    }
    if ([...match.participants.values()].every((x) => x.final || x.gone)) this.finishRound(room, fx);
    else this.broadcastRoom(room, fx);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Transfers (HTTP side)
  // ══════════════════════════════════════════════════════════════════════

  /** Single PUT of the whole file. */
  beginUpload(transferId: string, token: string): Ticket<UploadTicket> {
    const t = this.transfers.get(transferId);
    if (!t || !secretEquals(t.uploadToken, token)) return { ok: false, error: "Unknown transfer." };
    if (t.objectKey || t.uploadStarted) return { ok: false, error: "This transfer is not waiting for an upload." };
    t.uploadStarted = true;
    t.lastActivity = this.now;
    t.putKey = this.newObjectKey(t);
    return {
      ok: true,
      ticket: t.isPackedVariant
        ? { transferId: t.id, key: t.putKey, hash: t.hash, size: this.maxUploadBytes, exactSize: false }
        : { transferId: t.id, key: t.putKey, hash: t.hash, size: t.size, exactSize: true },
    };
  }

  beginChunkUpload(transferId: string, token: string, offset: number, chunkLength: number): Ticket<ChunkTicket> {
    const t = this.transfers.get(transferId);
    if (!t || !secretEquals(t.uploadToken, token)) return { ok: false, error: "Unknown transfer." };
    if (t.objectKey || (t.uploadStarted && !t.chunkKey))
      return { ok: false, error: "This transfer is not accepting chunked uploads." };
    if (t.chunkWriteInFlight) return { ok: false, error: "Another chunk upload is already in progress." };
    const maxSize = t.isPackedVariant ? this.maxUploadBytes : t.size;
    const chunkBytes = this.uploadChunkBytes;
    if (offset < 0 || offset > t.chunkBytesWritten)
      return { ok: false, error: `Invalid chunk offset ${offset} (expected <= ${t.chunkBytesWritten}).` };
    if (offset % chunkBytes !== 0)
      return { ok: false, error: `Chunk offsets must be multiples of ${chunkBytes} bytes (the server's UploadChunkBytes).` };
    if (chunkLength < 0 || chunkLength > chunkBytes || offset + chunkLength > maxSize)
      return { ok: false, error: "Chunk exceeds the allowed level size." };

    t.chunkKey ??= this.newObjectKey(t);
    t.uploadStarted = true;
    t.chunkWriteInFlight = true;
    t.lastActivity = this.now;
    return {
      ok: true,
      ticket: {
        transferId: t.id,
        key: t.chunkKey,
        uploadId: t.uploadId,
        partNumber: offset / chunkBytes + 1,
        chunkBytes,
        maxSize,
        exactSize: !t.isPackedVariant,
      },
    };
  }

  setMultipartUploadId(transferId: string, key: string, uploadId: string): boolean {
    const t = this.transfers.get(transferId);
    if (!t || t.chunkKey !== key) return false;
    t.uploadId = uploadId;
    return true;
  }

  finishChunkUpload(transferId: string, partNumber: number, etag: string, size: number, fx: Effects): void {
    const t = this.transfers.get(transferId);
    if (!t || t.objectKey) return;
    t.chunkWriteInFlight = false;
    t.parts.set(partNumber, { etag, size });
    const end = (partNumber - 1) * this.uploadChunkBytes + size;
    if (end > t.chunkBytesWritten) t.chunkBytesWritten = end;
    this.reportUploadProgress(t, t.chunkBytesWritten, fx);
  }

  abortChunkWrite(transferId: string): void {
    const t = this.transfers.get(transferId);
    if (t) {
      t.chunkWriteInFlight = false;
      t.lastActivity = this.now;
    }
  }

  beginCompleteChunkedUpload(transferId: string, token: string): Ticket<CompleteTicket> {
    const t = this.transfers.get(transferId);
    if (!t || !secretEquals(t.uploadToken, token)) return { ok: false, error: "Unknown transfer." };
    if (t.objectKey || !t.chunkKey || !t.uploadId) return { ok: false, error: "No chunked upload is waiting to complete." };
    if (t.chunkWriteInFlight) return { ok: false, error: "A chunk upload is still in progress." };
    if (t.chunkBytesWritten < 4) return { ok: false, error: "The file is too small to be a level." };

    const chunkBytes = this.uploadChunkBytes;
    const count = Math.ceil(t.chunkBytesWritten / chunkBytes);
    const parts: { partNumber: number; etag: string }[] = [];
    let total = 0;
    for (let n = 1; n <= count; n++) {
      const p = t.parts.get(n);
      if (!p) return { ok: false, error: `Chunk ${n} is missing; upload it again.` };
      if (n < count && p.size !== chunkBytes) return { ok: false, error: `Chunk ${n} has the wrong size; upload it again.` };
      parts.push({ partNumber: n, etag: p.etag });
      total += p.size;
    }

    t.chunkWriteInFlight = true;
    t.lastActivity = this.now;
    return {
      ok: true,
      ticket: {
        transferId: t.id,
        key: t.chunkKey,
        uploadId: t.uploadId,
        parts,
        totalBytes: total,
        maxSize: t.isPackedVariant ? this.maxUploadBytes : t.size,
        exactSize: !t.isPackedVariant,
        expectedHash: t.isPackedVariant ? "" : t.hash,
      },
    };
  }

  reportUploadBytes(transferId: string, bytes: number, fx: Effects): void {
    const t = this.transfers.get(transferId);
    if (!t || t.objectKey) return;
    this.reportUploadProgress(t, bytes, fx);
  }

  private reportUploadProgress(t: Transfer, bytes: number, fx: Effects): void {
    t.uploadBytes = bytes;
    t.lastActivity = this.now;
    const uploader = t.room.members.find((x) => x.session.playerId === t.uploaderId);
    const expected = t.size > 0 ? t.size : t.estimatedSize;
    if (uploader) uploader.uploadProgress = expected > 0 ? Math.min(1, bytes / expected) : 0;
    if (this.progressBroadcastDue(t.room)) this.broadcastRoom(t.room, fx);
  }

  /** The file is in R2: checks it, caches it for the room and starts every download. */
  completeUpload(transferId: string, key: string, actualHash: string, actualSize: number, fx: Effects): { ok: boolean; error: string } {
    const t = this.transfers.get(transferId);
    if (!t || t.objectKey) {
      fx.objectsToDelete.push(key);
      return { ok: false, error: "The transfer was cancelled." };
    }
    if (t.isPackedVariant) {
      t.size = actualSize;
      t.fileHash = actualHash.toLowerCase();
    } else if (actualHash.toLowerCase() !== t.hash || actualSize !== t.size) {
      fx.objectsToDelete.push(key);
      this.failTransfer(t, fx, "The uploaded file did not match the level (it may have changed on disk).", true);
      return { ok: false, error: "Uploaded file does not match the announced hash/size." };
    }

    t.chunkWriteInFlight = false;
    t.chunkKey = null;
    t.uploadId = null;
    t.putKey = null;
    t.objectKey = key;
    t.lastActivity = this.now;
    const existing = t.room.cache.get(t.cacheKey);
    if (existing && existing.key !== key) fx.objectsToDelete.push(existing.key);
    t.room.cache.set(t.cacheKey, {
      key,
      size: t.size,
      fileHash: t.fileHash,
      expiresAt: this.now + this.options.cacheMinutes * 60_000,
    });
    for (const u of t.room.members) {
      if (!this.isUploading(t.room, u.session.playerId)) u.uploadProgress = -1;
    }
    for (const m of t.room.members) this.offerDownload(t.room, m, fx);
    this.broadcastRoom(t.room, fx);
    return { ok: true, error: "" };
  }

  failUpload(transferId: string, reason: string, key: string | null, fx: Effects): void {
    if (key) fx.objectsToDelete.push(key);
    const t = this.transfers.get(transferId);
    if (t && !t.objectKey) this.failTransfer(t, fx, reason, true);
  }

  beginDownload(transferId: string, token: string): Ticket<DownloadTicket> {
    const t = this.transfers.get(transferId);
    if (!t || !t.objectKey) return { ok: false, error: "This transfer is not ready for download." };
    let d: Download | undefined;
    for (const x of t.downloads.values()) if (secretEquals(x.token, token)) d = x;
    if (!d) return { ok: false, error: "Unknown transfer." };
    d.lastActivity = this.now;
    d.bytes = 0;
    d.streamCompleted = false;
    const cached = t.room.cache.get(t.cacheKey);
    if (cached) cached.expiresAt = this.now + this.options.cacheMinutes * 60_000;
    return { ok: true, ticket: { transferId: t.id, key: t.objectKey, size: t.size, fileName: t.entry.fileName } };
  }

  /** Returns false when the download was dropped (the Worker then aborts the stream). */
  reportDownloadBytes(transferId: string, token: string, bytes: number, fx: Effects): boolean {
    const t = this.transfers.get(transferId);
    if (!t) return false;
    const d = this.findDownload(t, token);
    if (!d) return false;
    d.bytes = bytes;
    d.lastActivity = this.now;
    const m = t.room.members.find((x) => x.session.playerId === d.playerId);
    if (m && m.levelState !== Protocol.LevelReady) {
      m.levelState = Protocol.LevelDownloading;
      m.levelProgress = t.size > 0 ? Math.min(1, bytes / t.size) : 0;
    }
    if (this.progressBroadcastDue(t.room)) this.broadcastRoom(t.room, fx);
    return true;
  }

  markDownloadStreamComplete(transferId: string, token: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const d = this.findDownload(t, token);
    if (!d) return;
    d.streamCompleted = true;
    d.lastActivity = this.now;
  }

  private findDownload(t: Transfer, token: string): Download | undefined {
    for (const x of t.downloads.values()) if (x.token === token) return x;
    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Transfers (hub side)
  // ══════════════════════════════════════════════════════════════════════

  completeDownload(connectionId: string, transferId: string, ok: boolean, error: string | null, fx: Effects): void {
    const m = this.tryMember(connectionId);
    if (!m) return;
    const t = this.transfers.get(transferId);
    if (!t || t.room !== m.room) return;
    const hadPending = t.downloads.delete(m.session.playerId);
    if (!hadPending && !ok) return;
    if (ok) {
      if (t.variant === Protocol.VariantChartOnly) {
        m.chartOnlyHashes.add(t.hash);
        this.updateMemberLevelState(m);
      } else {
        m.levels.set(t.hash, { ...t.entry, hash: t.hash });
        m.room.levelsVersion++;
        this.updateMemberLevelState(m);
      }
    } else {
      m.levelState = Protocol.LevelFailed;
      m.levelProgress = 0;
      const why = error && error.trim().length > 0 ? clean(error, 160) : "verification failed";
      fx.send(m.session.connectionId, Protocol.TransferFailed, { hash: t.hash, reason: `Download failed: ${why}` });
    }
    this.tryAdvanceRound(m.room, fx);
    this.broadcastRoom(m.room, fx);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Maintenance
  // ══════════════════════════════════════════════════════════════════════

  sweep(fx: Effects): void {
    const now = this.now;
    const stall = this.options.stallTimeoutSeconds * 1000;
    const downloadGrace = Math.max(this.options.stallTimeoutSeconds, this.options.downloadCompletionGraceSeconds) * 1000;

    for (const t of [...this.transfers.values()]) {
      if (!t.objectKey) {
        if (now - t.lastActivity > stall) this.failTransfer(t, fx, "The level upload timed out.", true);
        continue;
      }
      for (const d of [...t.downloads.values()]) {
        if (now - d.lastActivity <= (d.streamCompleted ? downloadGrace : stall)) continue;
        t.downloads.delete(d.playerId);
        const m = t.room.members.find((x) => x.session.playerId === d.playerId);
        if (!m) continue;
        m.levelState = Protocol.LevelFailed;
        fx.send(m.session.connectionId, Protocol.TransferFailed, { hash: t.hash, reason: "The download timed out." });
        this.broadcastRoom(t.room, fx);
      }
    }

    const loadingTimeout =
      this.options.loadingTimeoutSeconds > 0 ? this.options.loadingTimeoutSeconds * 1000 : LoadingTimeoutMs;

    for (const room of [...this.rooms.values()]) {
      const match = room.match;
      if (match && room.phase === Protocol.PhaseLoading && now - match.createdAt > loadingTimeout) {
        const slow = [...match.participants.keys()].filter((id) => !match.loaded.has(id));
        for (const id of slow) match.participants.delete(id);
        const names = room.members.filter((x) => slow.includes(x.session.playerId)).map((x) => x.session.username);
        this.addSystemChat(room, `${names.join(", ")} took too long to load and will spectate.`, fx);
        if (!this.tryStartMatch(room, fx)) this.cancelMatch(room, fx, "Not enough players loaded the level. Round cancelled.");
      } else if (match && room.phase === Protocol.PhasePlaying && match.firstFinishAt !== null && now - match.firstFinishAt > FinishGraceMs) {
        this.finishRound(room, fx);
      } else if (match && room.phase === Protocol.PhasePlaying) {
        const silent = [...match.participants.values()].filter((p) => !p.final && !p.gone && now - p.lastSeen > SilenceTimeoutMs);
        for (const p of silent) {
          p.gone = true;
          const name =
            room.members.find((x) => x.session.playerId === p.assignment.playerId)?.session.username ??
            match.names.get(p.assignment.playerId) ??
            "A player";
          this.addSystemChat(room, `${name} stopped responding and left the match.`, fx);
        }
        if (silent.length > 0) {
          if ([...match.participants.values()].every((x) => x.final || x.gone)) this.finishRound(room, fx);
          else this.broadcastRoom(room, fx);
        }
      }

      if (room.progressDirty && now - room.lastProgressBroadcast >= this.options.progressIntervalMs) this.broadcastRoom(room, fx);

      for (const [key, file] of [...room.cache]) {
        if (file.expiresAt > now) continue;
        const hash = key.split(":")[0];
        if (room.song?.hash === hash || room.match?.info.song.hash === hash) continue;
        if ([...this.transfers.values()].some((t) => t.objectKey === file.key)) continue;
        room.cache.delete(key);
        fx.objectsToDelete.push(file.key);
      }

      for (const [id, until] of [...room.bans]) if (until <= now) room.bans.delete(id);
    }
  }

  getStats(): RegistryStats {
    let members = 0,
      matches = 0,
      cachedFiles = 0;
    for (const r of this.rooms.values()) {
      members += r.members.length;
      if (r.match) matches++;
      cachedFiles += r.cache.size;
    }
    return { sessions: this.sessions.size, rooms: this.rooms.size, members, matches, transfers: this.transfers.size, cachedFiles };
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: membership
  // ══════════════════════════════════════════════════════════════════════

  private tryMember(connectionId: string): Member | null {
    return this.sessions.get(connectionId)?.member ?? null;
  }

  private addMember(room: Room, s: Session, levels: unknown): Member {
    const member = new Member(s, room, ++this.joinSeq);
    member.levels = this.sanitizeLevels(levels);
    room.levelsVersion++;
    room.members.push(member);
    s.member = member;
    this.updateMemberLevelState(member);
    return member;
  }

  private removeMember(member: Member, fx: Effects, chatLine: string): void {
    const room = member.room;
    const wasHost = room.host === member;
    const wasTurn = room.turnMember === member;
    const playerId = member.session.playerId;

    room.members.splice(room.members.indexOf(member), 1);
    member.session.member = null;
    room.levelsVersion++;

    if (room.members.length === 0) {
      for (const t of this.roomTransfers(room)) this.endTransfer(t, fx);
      this.rooms.delete(room.id);
      for (const file of room.cache.values()) fx.objectsToDelete.push(file.key);
      room.cache.clear();
      return;
    }

    this.addSystemChat(room, chatLine, fx);
    if (wasHost && room.host) this.addSystemChat(room, `${room.host.session.username} is the new host.`, fx);

    for (const t of this.roomTransfers(room)) {
      t.downloads.delete(playerId);
      if (!t.objectKey && t.uploaderId === playerId)
        this.failTransfer(t, fx, `${member.session.username} left before sending the level.`, true);
    }

    const p = room.match?.participants.get(playerId);
    if (room.match && p) {
      if (room.phase === Protocol.PhaseLoading) {
        room.match.participants.delete(playerId);
        if (!this.tryStartMatch(room, fx) && room.match && room.match.participants.size < minParticipants())
          this.cancelMatch(room, fx, "Not enough players left. Round cancelled.");
      } else {
        p.gone = true;
        this.addSystemChat(room, `${member.session.username} left the match.`, fx);
        if ([...room.match.participants.values()].every((x) => x.final || x.gone)) this.finishRound(room, fx);
      }
    }

    if (room.phase === Protocol.PhaseLobby || room.phase === Protocol.PhaseSongSelected) {
      if (room.song && room.song.pickedBy === playerId) {
        this.clearSong(room, fx);
        this.addSystemChat(room, "Their song pick was cancelled.", fx);
      }
      if (wasTurn || wasHost) {
        if (room.settings.songSelection === Protocol.SelectHost && room.host) room.turnSeq = room.host.joinSeq;
        this.ensureTurn(room);
        this.announceTurn(room, fx);
      } else {
        this.ensureTurn(room);
      }
    }

    this.tryAdvanceRound(room, fx);
    this.broadcastRoom(room, fx);
  }

  private roomTransfers(room: Room): Transfer[] {
    return [...this.transfers.values()].filter((t) => t.room === room);
  }

  private isUploading(room: Room, playerId: string): boolean {
    for (const x of this.transfers.values()) if (x.room === room && !x.objectKey && x.uploaderId === playerId) return true;
    return false;
  }

  private hasSongForCurrentMode(m: Member, song: SongInfo): boolean {
    return (
      m.levels.has(song.hash) ||
      (song.kind === Protocol.KindFnf && m.session.fnfChartOnly && m.chartOnlyHashes.has(song.hash))
    );
  }

  private updateMemberLevelState(m: Member): void {
    const song = m.room.song ?? m.room.match?.info.song ?? null;
    if (!song) {
      m.levelState = Protocol.LevelMissing;
      m.levelProgress = 0;
      return;
    }
    if (this.hasSongForCurrentMode(m, song)) {
      m.levelState = Protocol.LevelReady;
      m.levelProgress = 1;
    } else if (m.levelState === Protocol.LevelReady && song.source === Protocol.SourceLocal) {
      m.levelState = Protocol.LevelMissing;
      m.levelProgress = 0;
      m.ready = false;
    }
  }

  private isPickable(room: Room, hash: string): boolean {
    const holders = room.settings.allowGuestLocalLevels ? room.members : room.members.slice(0, 1);
    for (const x of holders) {
      const e = x.levels.get(hash);
      if (e) return kindAllowed(room, e.kind);
    }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: turns
  // ══════════════════════════════════════════════════════════════════════

  private ensureTurn(room: Room): void {
    if (room.members.length === 0) return;
    if (room.settings.songSelection === Protocol.SelectHost) {
      room.turnSeq = room.host!.joinSeq;
      return;
    }
    const current = room.members.find((m) => m.joinSeq === room.turnSeq);
    if (current && canPick(current)) return;
    const next = nextEligibleAfter(room, room.turnSeq, true);
    room.turnSeq = next?.joinSeq ?? room.host!.joinSeq;
  }

  private advanceTurn(room: Room): void {
    if (room.members.length === 0) return;
    if (room.settings.songSelection === Protocol.SelectHost) {
      room.turnSeq = room.host!.joinSeq;
      return;
    }
    const next = nextEligibleAfter(room, room.turnSeq, false);
    room.turnSeq = next?.joinSeq ?? room.host!.joinSeq;
  }

  private announceTurn(room: Room, fx: Effects): void {
    const t = room.turnMember;
    if (t && canPick(t) && room.members.length > 1)
      this.addSystemChat(room, `It's ${t.session.username}'s turn to pick a song.`, fx);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: round state machine
  // ══════════════════════════════════════════════════════════════════════

  private startBlocker(room: Room): string | null {
    if (room.phase !== Protocol.PhaseSongSelected || !room.song) return null;
    const players = activePlayers(room);
    if (players.length < 2) return "Waiting for more players";
    if (room.settings.mode === Protocol.ModeVersus && players.length !== 2)
      return "Versus needs exactly 2 players (the rest can spectate)";
    const noLevel = players.filter((p) => p.levelState !== Protocol.LevelReady);
    if (noLevel.length > 0) return `Waiting for ${names(noLevel)} to get the level`;
    const notReady = players.filter((p) => !p.ready);
    if (notReady.length > 0) return `Waiting for ${names(notReady)} to be ready`;
    return null;
  }

  private tryAdvanceRound(room: Room, fx: Effects): void {
    if (room.phase !== Protocol.PhaseSongSelected || !room.song) return;
    if (this.startBlocker(room) !== null) return;

    const players = activePlayers(room);
    const info: MatchInfo = {
      matchId: newId(16),
      mode: room.settings.mode,
      song: room.song,
      players: [],
      startTimestamp: 0,
      mirrorSide: -1,
      loaded: [],
    };
    const shuffled = this.shuffle(players);
    switch (room.settings.mode) {
      case Protocol.ModeTeams: {
        const team0 = Math.trunc(shuffled.length / 2) + (shuffled.length % 2 === 1 ? this.randomInt(2) : 0);
        shuffled.forEach((p, i) => {
          const team = i < team0 ? 0 : 1;
          info.players.push({ playerId: p.session.playerId, side: team, team });
        });
        break;
      }
      case Protocol.ModeMirror: {
        const forPlayer = players.filter((p) => p.vote === Protocol.SidePlayer).length;
        const forEnemy = players.filter((p) => p.vote === Protocol.SideEnemy).length;
        const side =
          room.song.kind === Protocol.KindOsu
            ? Protocol.SidePlayer
            : forPlayer > forEnemy
              ? Protocol.SidePlayer
              : forEnemy > forPlayer
                ? Protocol.SideEnemy
                : this.randomInt(2);
        info.mirrorSide = side;
        for (const p of players) info.players.push({ playerId: p.session.playerId, side, team: -1 });
        break;
      }
      default:
        shuffled.forEach((p, i) => info.players.push({ playerId: p.session.playerId, side: i === 0 ? 0 : 1, team: -1 }));
        break;
    }

    const match = new MatchState(info, this.now);
    for (const a of info.players) match.participants.set(a.playerId, new Participant(a));
    for (const p of players) {
      match.names.set(p.session.playerId, p.session.username);
      match.hues.set(p.session.playerId, p.session.colorHue);
    }
    room.match = match;
    room.phase = Protocol.PhaseLoading;
    room.song = null;

    this.addSystemChat(room, describeMatch(room, info), fx);
    for (const m of room.members) fx.send(m.session.connectionId, Protocol.MatchLoading, info);
  }

  private tryStartMatch(room: Room, fx: Effects): boolean {
    const match = room.match;
    if (!match || room.phase !== Protocol.PhaseLoading) return false;
    if (match.participants.size < minParticipants()) return false;
    if (match.info.mode === Protocol.ModeVersus && match.participants.size !== 2) return false;
    if (![...match.participants.keys()].every((id) => match.loaded.has(id))) return true;

    let maxPing = 0;
    for (const m of room.members) if (match.participants.has(m.session.playerId)) maxPing = Math.max(maxPing, m.session.avgPing);
    const buffer = Math.trunc(clamp(maxPing * 2 + 400, 600, 2500));
    match.info.startTimestamp = this.now + buffer + CountdownMs;
    match.info.players = match.info.players.filter((a) => match.participants.has(a.playerId));
    room.phase = Protocol.PhasePlaying;
    for (const p of match.participants.values()) p.lastSeen = match.info.startTimestamp;

    const packet = { matchId: match.info.matchId, startTimestamp: match.info.startTimestamp };
    for (const m of room.members) fx.send(m.session.connectionId, Protocol.MatchStart, packet);
    this.broadcastRoom(room, fx);
    return true;
  }

  private cancelMatch(room: Room, fx: Effects, reason: string): void {
    const match = room.match;
    room.match = null;
    room.phase = Protocol.PhaseSongSelected;
    room.song = match?.info.song ?? null;
    if (!room.song) room.phase = Protocol.PhaseLobby;
    this.resetReady(room, false);
    for (const m of room.members) this.updateMemberLevelState(m);
    this.addSystemChat(room, reason, fx);
    this.ensureTurn(room);
    this.broadcastRoom(room, fx);
  }

  private finishRound(room: Room, fx: Effects): void {
    const match = room.match;
    if (!match) return;

    const results: PlayerResult[] = [];
    for (const p of match.participants.values()) {
      const member = room.members.find((m) => m.session.playerId === p.assignment.playerId);
      const name = member?.session.username ?? match.names.get(p.assignment.playerId) ?? "Player";
      const hue = member?.session.colorHue ?? match.hues.get(p.assignment.playerId) ?? 180;
      const r: PlayerResult = {
        playerId: p.assignment.playerId,
        username: name,
        colorHue: hue,
        side: p.assignment.side,
        team: p.assignment.team,
        score: 0,
        accuracy: 0,
        misses: 0,
        sicks: 0,
        goods: 0,
        bads: 0,
        shits: 0,
        maxCombo: 0,
        place: 0,
        disconnected: p.gone && (!p.final || p.final.quit),
      };
      const src = p.final ?? p.last;
      if (src) {
        r.score = src.score;
        r.accuracy = clamp(src.accuracy, 0, 100);
        r.misses = p.final ? Math.max(0, src.misses) : src.misses;
        r.sicks = src.sicks;
        r.goods = src.goods;
        r.bads = src.bads;
        r.shits = src.shits;
        r.maxCombo = src.maxCombo;
      }
      results.push(r);
    }

    const round: RoundResult = {
      matchId: match.info.matchId,
      mode: match.info.mode,
      song: match.info.song,
      players: [],
      teamScores: [],
      winningTeam: -1,
      finishedAt: this.now,
    };
    rankResults(results, round);
    round.players = results;

    room.history.push(round);
    if (room.history.length > MaxRoundHistory) room.history.shift();
    room.historyVersion++;
    if (results.filter((r) => !r.disconnected).length >= 2) fx.roundsToRecord.push(round);

    for (const m of room.members) fx.send(m.session.connectionId, Protocol.MatchResults, round);
    this.addSystemChat(room, describeResult(round), fx);

    for (const t of this.roomTransfers(room)) this.endTransfer(t, fx);
    room.match = null;
    room.song = null;
    room.phase = Protocol.PhaseLobby;
    this.resetReady(room, false);
    for (const m of room.members) this.updateMemberLevelState(m);
    const picker = room.members.find((m) => m.session.playerId === match.info.song.pickedBy);
    if (picker) room.turnSeq = picker.joinSeq;
    this.advanceTurn(room);
    this.announceTurn(room, fx);
    this.broadcastRoom(room, fx);
  }

  private resetReady(room: Room, keepPicker: boolean): void {
    for (const m of room.members) {
      const picker = keepPicker && room.song !== null && m.session.playerId === room.song.pickedBy;
      m.ready = picker && !m.spectate;
      m.vote = -1;
    }
  }

  private clearSong(room: Room, fx: Effects): void {
    for (const t of this.roomTransfers(room)) this.endTransfer(t, fx);
    room.song = null;
    if (room.phase === Protocol.PhaseSongSelected) room.phase = Protocol.PhaseLobby;
    this.resetReady(room, false);
    for (const m of room.members) {
      m.levelState = Protocol.LevelMissing;
      m.levelProgress = 0;
      m.uploadProgress = -1;
    }
  }

  private shuffle(list: Member[]): Member[] {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.randomInt(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: level transfers
  // ══════════════════════════════════════════════════════════════════════

  private startTransfer(room: Room, fx: Effects, excludeUploader: string | null = null, variant: string | null = null): void {
    const song = room.song ?? room.match?.info.song ?? null;
    if (!song || song.source !== Protocol.SourceLocal) return;
    const needers = room.members.filter((m) => !this.hasSongForCurrentMode(m, song));
    if (needers.length === 0) return;

    const variants = variant !== null ? [variant] : [...new Set(needers.map((m) => variantFor(m, song)))];
    for (const v of variants) {
      if ([...this.transfers.values()].some((x) => x.room === room && x.hash === song.hash && x.variant === v)) continue;
      this.startVariant(room, song, v, fx, excludeUploader);
    }
  }

  private startVariant(room: Room, song: SongInfo, variant: string, fx: Effects, excludeUploader: string | null): void {
    const cached = room.cache.get(cacheKeyOf(song.hash, variant));
    if (cached) {
      const t = this.newTransfer(room, song, variant, "");
      t.objectKey = cached.key;
      t.size = cached.size;
      t.fileHash = cached.fileHash;
      cached.expiresAt = this.now + this.options.cacheMinutes * 60_000;
      for (const m of room.members) this.offerDownload(room, m, fx);
      return;
    }

    const holders = room.members.filter((m) => m.levels.has(song.hash) && m.session.playerId !== excludeUploader);
    const uploader =
      holders.find((m) => m.session.playerId === song.pickedBy) ?? holders.find((m) => m === room.host) ?? holders[0];
    if (!uploader) {
      for (const m of room.members) {
        if (this.hasSongForCurrentMode(m, song) || variantFor(m, song) !== variant) continue;
        m.levelState = Protocol.LevelFailed;
        fx.send(m.session.connectionId, Protocol.TransferFailed, { hash: song.hash, reason: "Nobody in the room can send this level." });
      }
      return;
    }

    const tr = this.newTransfer(room, song, variant, uploader.session.playerId);
    uploader.uploadProgress = 0;
    fx.send(uploader.session.connectionId, Protocol.TransferUpload, {
      transferId: tr.id,
      token: tr.uploadToken,
      hash: song.hash,
      fileName: song.fileName,
      size: tr.size,
      kind: tr.kind,
      variant,
      maxSize: this.maxUploadBytes,
    });
  }

  private newTransfer(room: Room, song: SongInfo, variant: string, uploaderId: string): Transfer {
    const osu = song.kind === Protocol.KindOsu;
    const packed = osu || variant === Protocol.VariantChartOnly;
    let entry: LevelEntry | undefined;
    for (const m of room.members) {
      entry = m.levels.get(song.hash);
      if (entry) break;
    }
    const t = new Transfer(newId(16), room, song.hash, uploaderId, newId(24));
    t.entry = entry ?? entryFor(song);
    t.kind = osu ? Protocol.KindOsu : Protocol.KindFnf;
    t.variant = variant;
    t.size = packed ? 0 : song.size;
    t.estimatedSize =
      variant === Protocol.VariantNoVideo && song.sizeNoVideo > 0
        ? song.sizeNoVideo
        : variant === Protocol.VariantChartOnly
          ? Math.max(1, Math.min(song.size, 12 * 1024 * 1024))
          : song.size;
    t.fileHash = packed ? "" : song.hash;
    t.lastActivity = this.now;
    this.transfers.set(t.id, t);
    return t;
  }

  private newObjectKey(t: Transfer): string {
    return `transfers/${t.room.id}/${t.id}-${newId(8)}.bin`;
  }

  private offerDownload(room: Room, m: Member, fx: Effects): void {
    const song = room.song ?? room.match?.info.song ?? null;
    if (!song || song.source !== Protocol.SourceLocal || this.hasSongForCurrentMode(m, song)) return;

    const variant = variantFor(m, song);
    const find = () => [...this.transfers.values()].find((x) => x.room === room && x.hash === song.hash && x.variant === variant);
    let t = find();
    if (!t) {
      this.startTransfer(room, fx, null, variant);
      t = find();
      if (!t) return;
    }
    if (!t.objectKey) return;
    if (t.downloads.has(m.session.playerId)) return;

    const d: Download = { playerId: m.session.playerId, token: newId(24), bytes: 0, streamCompleted: false, lastActivity: this.now };
    t.downloads.set(d.playerId, d);
    m.levelState = Protocol.LevelDownloading;
    m.levelProgress = 0;
    fx.send(m.session.connectionId, Protocol.TransferDownload, {
      transferId: t.id,
      token: d.token,
      hash: t.hash,
      name: t.entry.name,
      fileName: t.entry.fileName,
      size: t.size,
      kind: t.kind,
      variant: t.variant,
      fileHash: t.fileHash,
    });
  }

  private failTransfer(t: Transfer, fx: Effects, reason: string, tryNextHolder: boolean): void {
    const failedUploader = t.uploaderId;
    this.endTransfer(t, fx);
    const room = t.room;
    for (const m of room.members) if (!this.isUploading(room, m.session.playerId)) m.uploadProgress = -1;
    if (!this.rooms.has(room.id)) return;

    const song = room.song ?? room.match?.info.song ?? null;
    if (
      tryNextHolder &&
      song &&
      song.hash === t.hash &&
      room.members.some((m) => m.levels.has(t.hash) && m.session.playerId !== failedUploader)
    ) {
      this.startTransfer(room, fx, failedUploader, t.variant);
    } else {
      for (const m of room.members) {
        const lacks = song ? !this.hasSongForCurrentMode(m, song) : !m.levels.has(t.hash);
        if (!lacks || (song && variantFor(m, song) !== t.variant)) continue;
        m.levelState = Protocol.LevelFailed;
        fx.send(m.session.connectionId, Protocol.TransferFailed, { hash: t.hash, reason });
      }
      this.addSystemChat(room, `Couldn't send ${t.entry.name}: ${reason}`, fx);
    }
    this.broadcastRoom(room, fx);
  }

  private endTransfer(t: Transfer, fx: Effects): void {
    this.transfers.delete(t.id);
    if (!t.objectKey) {
      if (t.chunkKey && t.uploadId) fx.multipartsToAbort.push({ key: t.chunkKey, uploadId: t.uploadId });
      if (t.putKey) fx.objectsToDelete.push(t.putKey);
      t.chunkKey = null;
      t.uploadId = null;
      t.putKey = null;
    }
    t.downloads.clear();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: broadcasting
  // ══════════════════════════════════════════════════════════════════════

  private progressBroadcastDue(room: Room): boolean {
    const now = this.now;
    if (now - room.lastProgressBroadcast < this.options.progressIntervalMs) {
      room.progressDirty = true;
      return false;
    }
    room.lastProgressBroadcast = now;
    return true;
  }

  private addSystemChat(room: Room, text: string, fx: Effects): void {
    this.addChat(room, { playerId: "", username: "", colorHue: 180, text, system: true, timestamp: this.now }, fx);
  }

  private addChat(room: Room, msg: ChatMessage, fx: Effects): void {
    room.chat.push(msg);
    if (room.chat.length > MaxChatHistory) room.chat.shift();
    for (const m of room.members) fx.send(m.session.connectionId, Protocol.Chat, msg);
  }

  private sendChatHistory(room: Room, s: Session, fx: Effects): void {
    for (const msg of room.chat) fx.send(s.connectionId, Protocol.Chat, msg);
  }

  private broadcastRoom(room: Room, fx: Effects): void {
    if (!this.rooms.has(room.id)) return;
    room.lastProgressBroadcast = this.now;
    room.progressDirty = false;
    const blocker = this.startBlocker(room);
    const turn = room.turnMember;
    const inMatch = room.phase === Protocol.PhaseLoading || room.phase === Protocol.PhasePlaying;

    const members: RoomMember[] = room.members.map((m) => {
      const id = m.session.playerId;
      let status: string;
      if (inMatch) {
        const part = room.match!.participants.get(id);
        status = part
          ? part.gone || part.final?.quit
            ? Protocol.StatusLeftMatch
            : part.final
              ? Protocol.StatusFinished
              : Protocol.StatusPlaying
          : Protocol.StatusSpectating;
      } else {
        status = m.spectate ? Protocol.StatusSpectating : m.ready ? Protocol.StatusReady : Protocol.StatusNotReady;
      }
      return {
        id,
        username: m.session.username,
        colorHue: m.session.colorHue,
        isHost: m === room.host,
        status,
        spectate: m.spectate,
        levelStatus: m.levelState,
        levelProgress: m.levelProgress,
        uploadProgress: m.uploadProgress,
        vote: m.vote,
      };
    });

    // Union of every local level in the room (built lazily: only when somebody needs the list).
    let all: Map<string, LevelEntry> | null = null;
    const union = () => {
      if (all) return all;
      all = new Map();
      for (const m of room.members) for (const [hash, entry] of m.levels) if (!all.has(hash)) all.set(hash, entry);
      return all;
    };
    const pickable = new Map<string, boolean>();

    for (const member of room.members) {
      let levels: RoomLevel[] | null = null;
      if (member.sentLevelsVersion !== room.levelsVersion) {
        member.sentLevelsVersion = room.levelsVersion;
        levels = [];
        for (const [hash, entry] of union()) {
          const own = member.levels.get(hash);
          const src = own ?? entry;
          let pick = pickable.get(hash);
          if (pick === undefined) {
            pick = this.isPickable(room, hash);
            pickable.set(hash, pick);
          }
          levels.push({
            hash,
            name: src.name,
            fileName: src.fileName,
            size: src.size,
            stars: src.stars,
            kind: src.kind,
            setId: src.setId,
            setName: src.setName,
            difficulty: src.difficulty,
            sizeNoVideo: src.sizeNoVideo,
            youHave: own !== undefined,
            holders: room.members.filter((o) => o !== member && o.levels.has(hash)).map((o) => o.session.playerId),
            pickable: pick,
          });
        }
      }
      let history: RoundResult[] | null = null;
      if (member.sentHistoryVersion !== room.historyVersion) {
        member.sentHistoryVersion = room.historyVersion;
        history = [...room.history];
      }

      const packet: RoomStatePacket = {
        roomId: room.id,
        name: room.name,
        settings: {
          mode: room.settings.mode,
          songSelection: room.settings.songSelection,
          maxPlayers: room.settings.maxPlayers,
          allowGuestLocalLevels: room.settings.allowGuestLocalLevels,
          songTypes: room.settings.songTypes,
          password: member === room.host ? room.settings.password : "",
        },
        hasPassword: room.settings.password.length > 0,
        phase: room.phase,
        members,
        hostId: room.host?.session.playerId ?? "",
        youId: member.session.playerId,
        turnPlayerId: !inMatch && turn && canPick(turn) ? turn.session.playerId : "",
        song: room.song,
        match: room.match?.info ?? null,
        startBlocker: blocker ?? "",
        levels,
        history,
      };
      fx.send(member.session.connectionId, Protocol.RoomState, packet);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internals: validation
  // ══════════════════════════════════════════════════════════════════════

  private sanitizeSettings(raw: Partial<RoomSettings> | undefined, minPlayers: number): { settings: RoomSettings } | { error: string } {
    const s = raw ?? {};
    const modeIn = str(s.mode, Protocol.ModeVersus);
    const mode = modeIn === Protocol.ModeVersus || modeIn === Protocol.ModeTeams || modeIn === Protocol.ModeMirror ? modeIn : "";
    if (mode.length === 0) return { error: "Unknown game mode." };
    const selIn = str(s.songSelection, Protocol.SelectTurns);
    const sel = selIn === Protocol.SelectTurns || selIn === Protocol.SelectHost ? selIn : "";
    if (sel.length === 0) return { error: "Unknown song selection mode." };
    const maxPlayers = int(s.maxPlayers, 2);
    if (maxPlayers < Protocol.MinPlayers || maxPlayers > this.maxRoomPlayers)
      return { error: `The player limit must be between ${Protocol.MinPlayers} and ${this.maxRoomPlayers}.` };
    if (maxPlayers < minPlayers) return { error: `There are already ${minPlayers} players in the room.` };
    const password = str(s.password).trim();
    if (password.length > 32) return { error: "The password can be at most 32 characters." };
    const typesIn = str(s.songTypes, Protocol.SongTypesBoth);
    const types =
      typesIn === Protocol.SongTypesFnf || typesIn === Protocol.SongTypesOsu || typesIn === Protocol.SongTypesBoth
        ? typesIn
        : Protocol.SongTypesBoth;
    if (types === Protocol.SongTypesOsu && mode !== Protocol.ModeMirror)
      return { error: "osu!mania only rooms must use Mirror mode (osu! songs have a single strumline)." };
    return {
      settings: {
        mode,
        songSelection: sel,
        password,
        maxPlayers,
        allowGuestLocalLevels: bool(s.allowGuestLocalLevels, true),
        songTypes: types,
      },
    };
  }

  private sanitizeLevels(levels: unknown): Map<string, LevelEntry> {
    const result = new Map<string, LevelEntry>();
    if (!Array.isArray(levels)) return result;
    for (const raw of levels) {
      if (result.size >= this.options.maxLevelsPerMember) break;
      if (!raw || typeof raw !== "object") continue;
      const l = raw as Partial<LevelEntry>;
      const hash = str(l.hash).trim().toLowerCase();
      const size = num(l.size);
      if (!HashRegex.test(hash) || size <= 0) continue;
      const osu = str(l.kind) === Protocol.KindOsu;
      const sizeNoVideoIn = num(l.sizeNoVideo);
      const noVideo = osu && sizeNoVideoIn > 0 && sizeNoVideoIn < size ? sizeNoVideoIn : 0;
      const smallest = noVideo > 0 ? noVideo : size;
      if (smallest > this.maxUploadBytes) continue;
      const fileName = cleanFileName(str(l.fileName), osu);
      if (fileName.length === 0) continue;
      let name = osu ? clean(str(l.name), 120) : cleanName(str(l.name), fileNameWithoutExtension(fileName));
      if (name.length === 0) name = clean(fileNameWithoutExtension(fileName), 120);
      const starsIn = num(l.stars);
      const stars = Number.isFinite(starsIn) ? clamp(starsIn, 0, 99) : 0;
      const entry: LevelEntry = {
        hash,
        name,
        fileName,
        size,
        stars,
        kind: Protocol.KindFnf,
        setId: "",
        setName: "",
        difficulty: "",
        sizeNoVideo: 0,
      };
      if (osu) {
        entry.kind = Protocol.KindOsu;
        entry.setId = clean(str(l.setId), 64);
        entry.setName = clean(str(l.setName), 100);
        entry.difficulty = clean(str(l.difficulty), 64);
        entry.sizeNoVideo = noVideo;
        if (entry.setId.length === 0) continue;
      }
      if (!result.has(hash)) result.set(hash, entry);
    }
    return result;
  }

  private newRoomId(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id: string;
    do {
      const buf = new Uint8Array(6);
      crypto.getRandomValues(buf);
      id = [...buf].map((b) => chars[b % chars.length]).join("");
    } while (this.rooms.has(id));
    return id;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Free helpers
// ══════════════════════════════════════════════════════════════════════════

function minParticipants(): number {
  return 2;
}

function canPick(m: Member): boolean {
  return !m.spectate;
}

function activePlayers(room: Room): Member[] {
  return room.members.filter((m) => !m.spectate);
}

function nextEligibleAfter(room: Room, seq: number, inclusive: boolean): Member | null {
  const ordered = room.members;
  const after = ordered.filter((m) => (inclusive ? m.joinSeq >= seq : m.joinSeq > seq)).filter(canPick);
  return after[0] ?? ordered.filter(canPick)[0] ?? null;
}

function names(list: Member[]): string {
  return list.length <= 2 ? list.map((m) => m.session.username).join(" and ") : `${list.length} players`;
}

function kindAllowed(room: Room, kind: string): boolean {
  if (kind === Protocol.KindOsu && room.settings.mode !== Protocol.ModeMirror) return false;
  switch (room.settings.songTypes) {
    case Protocol.SongTypesFnf:
      return kind !== Protocol.KindOsu;
    case Protocol.SongTypesOsu:
      return kind === Protocol.KindOsu;
    default:
      return true;
  }
}

function entryFor(song: SongInfo): LevelEntry {
  return {
    hash: song.hash,
    name: song.name,
    fileName: song.fileName,
    size: song.size,
    stars: song.stars,
    kind: song.kind,
    setId: song.setId,
    setName: song.setName,
    difficulty: song.difficulty,
    sizeNoVideo: song.sizeNoVideo,
  };
}

function variantFor(m: Member, song: SongInfo): string {
  return song.kind === Protocol.KindOsu
    ? m.session.osuSkipVideo && song.sizeNoVideo > 0 && song.sizeNoVideo < song.size
      ? Protocol.VariantNoVideo
      : Protocol.VariantFull
    : m.session.fnfChartOnly
      ? Protocol.VariantChartOnly
      : Protocol.VariantFull;
}

function emptySong(): SongInfo {
  return {
    source: Protocol.SourceOfficial,
    hash: "",
    name: "",
    fileName: "",
    size: 0,
    officialId: "",
    stars: 0,
    pickedBy: "",
    kind: Protocol.KindFnf,
    setId: "",
    setName: "",
    difficulty: "",
    sizeNoVideo: 0,
  };
}

function sanitizeFinish(raw: Partial<FinishMatchRequest> | undefined): FinishMatchRequest {
  const r = raw ?? {};
  return {
    matchId: str(r.matchId),
    score: Math.trunc(num(r.score)),
    accuracy: num(r.accuracy),
    misses: int(r.misses),
    sicks: int(r.sicks),
    goods: int(r.goods),
    bads: int(r.bads),
    shits: int(r.shits),
    maxCombo: int(r.maxCombo),
    quit: bool(r.quit),
  };
}

export function sanitizeState(raw: Partial<PlayerStatePacket> | undefined): PlayerStatePacket {
  const r = raw ?? {};
  return {
    playerId: "",
    score: Math.trunc(num(r.score)),
    combo: int(r.combo),
    maxCombo: int(r.maxCombo),
    accuracy: num(r.accuracy),
    sicks: int(r.sicks),
    goods: int(r.goods),
    bads: int(r.bads),
    shits: int(r.shits),
    misses: int(r.misses),
    songTime: num(r.songTime),
    left: bool(r.left),
  };
}

/** C# Math.Round (banker's rounding: halves go to the even neighbour). */
export function roundHalfEven(x: number, decimals = 0): number {
  const f = 10 ** decimals;
  const v = x * f;
  const r = Math.round(v);
  const isHalf = Math.abs(v % 1) === 0.5;
  const result = isHalf ? (r % 2 === 0 ? r : r - 1) : r;
  return result / f;
}

/** Orders results and sets places. Disconnected players are always last. Teams: higher average wins. */
export function rankResults(results: PlayerResult[], round: RoundResult): void {
  results.sort((a, b) => {
    const d = Number(a.disconnected) - Number(b.disconnected);
    if (d !== 0) return d;
    const s = b.score - a.score;
    return s !== 0 ? s : b.accuracy - a.accuracy;
  });
  for (let i = 0; i < results.length; i++) {
    const tie = i > 0 && results[i].score === results[i - 1].score && results[i].disconnected === results[i - 1].disconnected;
    results[i].place = tie ? results[i - 1].place : i + 1;
  }

  if (round.mode === Protocol.ModeTeams) {
    const avg = (team: number) => {
      const list = results.filter((r) => r.team === team);
      return list.length === 0 ? 0 : list.reduce((sum, r) => sum + r.score, 0) / list.length;
    };
    const a0 = avg(0),
      a1 = avg(1);
    round.teamScores = [roundHalfEven(a0, 1), roundHalfEven(a1, 1)];
    round.winningTeam = a0 > a1 ? 0 : a1 > a0 ? 1 : -1;
  }
}

function describeMatch(room: Room, info: MatchInfo): string {
  const nameOf = (id: string) => room.members.find((m) => m.session.playerId === id)?.session.username ?? "?";
  const sideName = (s: number) => (s === Protocol.SidePlayer ? "Player" : "Enemy");
  switch (info.mode) {
    case Protocol.ModeTeams: {
      const t0 = info.players.filter((p) => p.team === 0).map((p) => nameOf(p.playerId));
      const t1 = info.players.filter((p) => p.team === 1).map((p) => nameOf(p.playerId));
      return `Round starting: ${info.song.name}. Team Player: ${t0.join(", ")} | Team Enemy: ${t1.join(", ")}.`;
    }
    case Protocol.ModeMirror:
      return `Round starting: ${info.song.name}. Everybody plays as ${sideName(info.mirrorSide)}.`;
    default:
      return (
        `Round starting: ${info.song.name}. ` +
        info.players.map((p) => `${nameOf(p.playerId)} (${sideName(p.side)})`).join(" vs ") +
        "."
      );
  }
}

function describeResult(round: RoundResult): string {
  if (round.mode === Protocol.ModeTeams) {
    const f = (x: number) => Math.round(x).toString();
    if (round.winningTeam === 0)
      return `Team Player wins ${round.song.name}! (${f(round.teamScores[0])} vs ${f(round.teamScores[1])} avg)`;
    if (round.winningTeam === 1)
      return `Team Enemy wins ${round.song.name}! (${f(round.teamScores[1])} vs ${f(round.teamScores[0])} avg)`;
    return `${round.song.name} ended in a draw between the teams.`;
  }
  const winners = round.players.filter((p) => p.place === 1 && !p.disconnected);
  if (winners.length === 0) return `${round.song.name} ended.`;
  if (winners.length > 1) return `${round.song.name} ended in a draw.`;
  return `${winners[0].username} wins ${round.song.name} with ${winners[0].score.toLocaleString("en-US")} points!`;
}

export function songTypesName(types: string): string {
  return types === Protocol.SongTypesFnf ? "FNF only" : types === Protocol.SongTypesOsu ? "osu!mania only" : "FNF & osu!";
}

export function modeName(mode: string): string {
  return mode === Protocol.ModeTeams ? "Teams" : mode === Protocol.ModeMirror ? "Mirror" : "Versus";
}

export function selectionName(sel: string): string {
  return sel === Protocol.SelectHost ? "host only" : "turns";
}

// ── String helpers (ports of the C# Clean / CleanName / CleanFileName) ──────

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function clean(value: string | null | undefined, max: number): string {
  if (!value) return "";
  let out = "";
  for (let i = 0; i < value.length && out.length < max; i++) {
    if (!isControl(value.charCodeAt(i))) out += value[i];
  }
  return out.trim();
}

function cleanName(value: string, fallback: string): string {
  const s = clean(value, 32);
  return s.length > 0 ? s : clean(fallback, 100);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function fileNameWithoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

/** A safe file name ending in .fnmm / .zip / .rar (osu! sets: .osz), or "". */
export function cleanFileName(fileName: string, osu = false): string {
  const parts = (fileName ?? "").replace(/\\/g, "/").split("/");
  let name = parts[parts.length - 1];
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    out += isControl(name.charCodeAt(i)) || '<>:"/\\|?*'.includes(c) ? "_" : c;
  }
  name = out.trim().replace(/\.+$/, "");
  if (name.length > 120) name = name.slice(name.length - 120);
  const ext = extensionOf(name).toLowerCase();
  const ok = osu ? ext === ".osz" : ext === ".fnmm" || ext === ".zip" || ext === ".rar";
  return ok && name.length > ext.length ? name : "";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function secretEquals(expected: string, actual: string | null | undefined): boolean {
  if (actual === null || actual === undefined) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(actual.trim());
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function newId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
