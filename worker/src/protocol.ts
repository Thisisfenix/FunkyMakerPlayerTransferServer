// Wire types shared with the game client (FunkyMakerPlayer/Multiplayer/Rooms/RoomProtocol.cs).
// Port of src/FunkyMakerTransferServer/Protocol.cs. Field names are camelCase on the wire (what
// SignalR's JSON protocol sent); incoming messages are accepted in any casing (see normalizeKeys).

export const Protocol = {
  /**
   * 4 = Cloudflare Workers server: plain WebSocket envelope instead of SignalR (see hub.ts),
   *     chunked uploads as R2 multipart parts, X-File-Hash on packed uploads.
   * 3 = osu!mania songs. 2 = room system. 1 = old pair-transfer server.
   */
  Version: 4,

  KindFnf: "fnf",
  KindOsu: "osu",

  SongTypesFnf: "fnf",
  SongTypesOsu: "osu",
  SongTypesBoth: "both",

  VariantFull: "full",
  VariantNoVideo: "novideo",
  VariantChartOnly: "chartonly",

  // Server → client events
  RoomState: "RoomState",
  Chat: "Chat",
  Kicked: "Kicked",
  TransferUpload: "TransferUpload",
  TransferDownload: "TransferDownload",
  TransferFailed: "TransferFailed",
  MatchLoading: "MatchLoading",
  MatchStart: "MatchStart",
  MatchResults: "MatchResults",
  PlayerState: "PlayerState",
  PlayerHit: "PlayerHit",
  PlayerKeyPress: "PlayerKeyPress",
  Pong: "Pong",

  ModeVersus: "versus",
  ModeTeams: "teams",
  ModeMirror: "mirror",

  SelectTurns: "turns",
  SelectHost: "host",

  SourceOfficial: "official",
  SourceLocal: "local",

  PhaseLobby: "lobby",
  PhaseSongSelected: "selected",
  PhaseLoading: "loading",
  PhasePlaying: "playing",

  StatusNotReady: "notready",
  StatusReady: "ready",
  StatusPlaying: "playing",
  StatusSpectating: "spectating",
  StatusFinished: "finished",
  StatusLeftMatch: "leftmatch",

  LevelMissing: "missing",
  LevelDownloading: "downloading",
  LevelReady: "ready",
  LevelFailed: "failed",

  SidePlayer: 0,
  SideEnemy: 1,

  TokenHeader: "X-Transfer-Token",
  /** SHA-256 (lower-case hex) of the uploaded file; required for packed variants (osu! .osz, chartonly). */
  FileHashHeader: "X-File-Hash",

  MinPlayers: 2,
  MaxPlayers: 8,
  HardMaxPlayers: 32,
  MaxRoomNameLength: 32,
  MaxChatLength: 200,
} as const;

// ── Session ────────────────────────────────────────────────────────────────

export interface HelloRequest {
  playerId: string;
  username: string;
  colorHue: number;
  clientVersion: string;
  protocolVersion: number;
  osuSkipVideo: boolean;
  fnfChartOnly: boolean;
}

export interface HelloResult {
  ok: boolean;
  error: string;
  protocolVersion: number;
  serverVersion: string;
  maxUploadBytes: number;
  maxRoomPlayers: number;
  supportsChunkedUpload: boolean;
  supportsFnfChartOnly: boolean;
  uploadChunkBytes: number;
}

export interface OpResult {
  ok: boolean;
  error: string;
  roomId: string;
}

export const OpResult = {
  success: (roomId = ""): OpResult => ({ ok: true, error: "", roomId }),
  fail: (error: string): OpResult => ({ ok: false, error, roomId: "" }),
};

export interface PongPacket {
  clientTimestamp: number;
  serverTimestamp: number;
  ping: number;
}

// ── Rooms ──────────────────────────────────────────────────────────────────

export interface LevelEntry {
  hash: string;
  name: string;
  fileName: string;
  size: number;
  stars: number;
  kind: string;
  setId: string;
  setName: string;
  difficulty: string;
  sizeNoVideo: number;
}

export interface RoomSettings {
  mode: string;
  songSelection: string;
  password: string;
  maxPlayers: number;
  allowGuestLocalLevels: boolean;
  songTypes: string;
}

export interface CreateRoomRequest {
  name: string;
  settings: Partial<RoomSettings>;
  levels: Partial<LevelEntry>[];
}

export interface JoinRoomRequest {
  roomId: string;
  password: string;
  levels: Partial<LevelEntry>[];
}

export interface RoomPlayerSummary {
  id: string;
  username: string;
  colorHue: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  hasPassword: boolean;
  mode: string;
  phase: string;
  songName: string;
  songStars: number;
  hostName: string;
  players: RoomPlayerSummary[];
  playerCount: number;
  maxPlayers: number;
}

export interface SongInfo {
  source: string;
  hash: string;
  name: string;
  fileName: string;
  size: number;
  officialId: string;
  stars: number;
  pickedBy: string;
  kind: string;
  setId: string;
  setName: string;
  difficulty: string;
  sizeNoVideo: number;
}

export interface RoomMember {
  id: string;
  username: string;
  colorHue: number;
  isHost: boolean;
  status: string;
  spectate: boolean;
  levelStatus: string;
  levelProgress: number;
  uploadProgress: number;
  vote: number;
}

export interface RoomLevel {
  hash: string;
  name: string;
  fileName: string;
  size: number;
  stars: number;
  youHave: boolean;
  holders: string[];
  pickable: boolean;
  kind: string;
  setId: string;
  setName: string;
  difficulty: string;
  sizeNoVideo: number;
}

export interface MatchAssignment {
  playerId: string;
  side: number;
  team: number;
}

export interface MatchInfo {
  matchId: string;
  mode: string;
  song: SongInfo;
  players: MatchAssignment[];
  startTimestamp: number;
  mirrorSide: number;
  loaded: string[];
}

export interface MatchStartPacket {
  matchId: string;
  startTimestamp: number;
}

export interface PlayerResult {
  playerId: string;
  username: string;
  colorHue: number;
  side: number;
  team: number;
  score: number;
  accuracy: number;
  misses: number;
  sicks: number;
  goods: number;
  bads: number;
  shits: number;
  maxCombo: number;
  place: number;
  disconnected: boolean;
}

export interface RoundResult {
  matchId: string;
  mode: string;
  song: SongInfo;
  players: PlayerResult[];
  teamScores: number[];
  winningTeam: number;
  finishedAt: number;
}

export interface ChatMessage {
  playerId: string;
  username: string;
  colorHue: number;
  text: string;
  system: boolean;
  timestamp: number;
}

export interface RoomStatePacket {
  roomId: string;
  name: string;
  settings: RoomSettings;
  hasPassword: boolean;
  phase: string;
  members: RoomMember[];
  hostId: string;
  youId: string;
  turnPlayerId: string;
  song: SongInfo | null;
  match: MatchInfo | null;
  startBlocker: string;
  levels: RoomLevel[] | null;
  history: RoundResult[] | null;
}

// ── Round flow ─────────────────────────────────────────────────────────────

export interface SongSelection {
  source: string;
  hash: string;
  name: string;
  officialId: string;
  stars: number;
}

export interface LevelStatusUpdate {
  hash: string;
  state: string;
  progress: number;
}

export interface TransferUploadPacket {
  transferId: string;
  token: string;
  hash: string;
  fileName: string;
  size: number;
  kind: string;
  variant: string;
  maxSize: number;
}

export interface TransferDownloadPacket {
  transferId: string;
  token: string;
  hash: string;
  name: string;
  fileName: string;
  size: number;
  kind: string;
  variant: string;
  fileHash: string;
}

export interface TransferFailedPacket {
  hash: string;
  reason: string;
}

export interface KickedPacket {
  reason: string;
}

// ── In-match relay ─────────────────────────────────────────────────────────

export interface PlayerStatePacket {
  playerId: string;
  score: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  sicks: number;
  goods: number;
  bads: number;
  shits: number;
  misses: number;
  songTime: number;
  left: boolean;
}

export interface FinishMatchRequest {
  matchId: string;
  score: number;
  accuracy: number;
  misses: number;
  sicks: number;
  goods: number;
  bads: number;
  shits: number;
  maxCombo: number;
  quit: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Lower-cases the first letter of every object key (PascalCase C# clients → camelCase), recursively. */
export function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.length > 0 ? k[0].toLowerCase() + k.slice(1) : k;
      out[key] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
export const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
export const int = (v: unknown, fallback = 0): number => Math.trunc(num(v, fallback));
export const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
