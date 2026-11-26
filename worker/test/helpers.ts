import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { Protocol, type LevelEntry, type RoomSettings, type RoomStatePacket } from "../src/protocol";
import { Effects, RoomRegistry, type OfficialLevel, type RegistryOptions } from "../src/registry";

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Registry driven by a fake clock; every message is delivered to the TestPlayer with that connection. */
export class World {
  time = 1_700_000_000_000;
  official = new Map<string, OfficialLevel>();
  registry: RoomRegistry;
  players = new Map<string, TestPlayer>();
  deleted: string[] = [];
  aborted: string[] = [];
  rounds: unknown[] = [];

  constructor(options: Partial<RegistryOptions> = {}) {
    this.registry = new RoomRegistry({ progressIntervalMs: 0, ...options }, () => this.time, (h) => this.official.get(h) ?? null);
  }

  run<T>(action: (fx: Effects) => T): T {
    const fx = new Effects();
    const result = action(fx);
    for (const m of fx.messages) this.players.get(m.connectionId)?.messages.push({ method: m.method, payload: structuredClone(m.payload) });
    this.deleted.push(...fx.objectsToDelete);
    this.aborted.push(...fx.multipartsToAbort.map((x) => x.key));
    this.rounds.push(...fx.roundsToRecord);
    return result;
  }

  advance(ms: number): void {
    this.time += ms;
    this.run((fx) => this.registry.sweep(fx));
  }

  addOfficial(name: string): OfficialLevel {
    const hash = sha256(randomBytes(64));
    const l = { id: name.toLowerCase(), name, fileName: name + ".FNMM", hash, size: 1234 };
    this.official.set(hash, l);
    return l;
  }

  connect(name: string, levels: TestLevel[] = [], prefs: { osuSkipVideo?: boolean; fnfChartOnly?: boolean } = {}): TestPlayer {
    const p = new TestPlayer(this, name, levels);
    this.players.set(p.conn, p);
    const hello = this.run((fx) =>
      this.registry.hello(
        p.conn,
        { playerId: p.playerId, username: name, colorHue: 120, protocolVersion: Protocol.Version, ...prefs },
        fx,
      ),
    );
    expect(hello.ok, hello.error).toBe(true);
    return p;
  }

  /** Simulates the HTTP side of an upload into "R2" (whole file at once, or chunked). */
  upload(transferId: string, token: string, bytes: Uint8Array, opts: { chunked?: boolean; hash?: string } = {}) {
    const r = this.registry;
    if (!opts.chunked) {
      const b = r.beginUpload(transferId, token);
      if (!b.ok) return { ok: false, error: b.error };
      return this.run((fx) => r.completeUpload(transferId, b.ticket.key, opts.hash ?? sha256(bytes), bytes.length, fx));
    }
    const chunk = r.uploadChunkBytes;
    let key = "";
    for (let off = 0; off < bytes.length; off += chunk) {
      const len = Math.min(chunk, bytes.length - off);
      const b = r.beginChunkUpload(transferId, token, off, len);
      if (!b.ok) return { ok: false, error: b.error };
      key = b.ticket.key;
      if (!b.ticket.uploadId) r.setMultipartUploadId(transferId, key, "mp-1");
      this.run((fx) => r.finishChunkUpload(transferId, b.ticket.partNumber, `etag-${b.ticket.partNumber}`, len, fx));
    }
    const c = r.beginCompleteChunkedUpload(transferId, token);
    if (!c.ok) return { ok: false, error: c.error };
    const hash = c.ticket.expectedHash || opts.hash || sha256(bytes);
    return this.run((fx) => r.completeUpload(transferId, c.ticket.key, hash, c.ticket.totalBytes, fx));
  }
}

export class TestLevel {
  setId: string | null = null;
  setSize = 0;
  setSizeNoVideo = 0;
  constructor(
    readonly name: string,
    readonly bytes: Uint8Array,
  ) {}

  get hash(): string {
    return sha256(this.bytes);
  }

  get entry(): Partial<LevelEntry> {
    return this.setId === null
      ? { hash: this.hash, name: this.name, fileName: this.name + ".fnmm", size: this.bytes.length, stars: 3.5 }
      : {
          hash: this.hash,
          name: this.name + " [Hard]",
          fileName: this.name + ".osz",
          size: this.setSize,
          stars: 3.5,
          kind: Protocol.KindOsu,
          setId: this.setId,
          setName: this.name,
          difficulty: "Hard",
          sizeNoVideo: this.setSizeNoVideo,
        };
  }

  static create(name: string, size = 300_000): TestLevel {
    return new TestLevel(name, TestLevel.package(size));
  }

  static osu(name: string, setSize = 2_000_000, sizeNoVideo = 0): TestLevel {
    const l = new TestLevel(name, new Uint8Array(randomBytes(4000)));
    l.setId = "set-" + name.toLowerCase();
    l.setSize = setSize;
    l.setSizeNoVideo = sizeNoVideo;
    return l;
  }

  static package(size: number): Uint8Array {
    const b = new Uint8Array(randomBytes(size));
    b[0] = 0x50;
    b[1] = 0x4b;
    b[2] = 3;
    b[3] = 4;
    return b;
  }
}

export class TestPlayer {
  readonly conn = randomUUID();
  readonly playerId = randomUUID();
  messages: { method: string; payload: any }[] = [];

  constructor(
    private readonly w: World,
    readonly name: string,
    readonly levels: TestLevel[],
  ) {}

  private get r() {
    return this.w.registry;
  }

  all<T = any>(method: string): T[] {
    return this.messages.filter((m) => m.method === method).map((m) => m.payload as T);
  }

  latest<T = any>(method: string): T | undefined {
    const a = this.all<T>(method);
    return a[a.length - 1];
  }

  /** Latest room state (merged: levels / history null = unchanged). */
  get state(): RoomStatePacket {
    const all = this.all<RoomStatePacket>(Protocol.RoomState);
    const last = { ...all[all.length - 1] };
    last.levels ??= [...all].reverse().find((s) => s.levels !== null)?.levels ?? null;
    last.history ??= [...all].reverse().find((s) => s.history !== null)?.history ?? null;
    return last;
  }

  chatHas(text: string): boolean {
    return this.all<{ text: string }>(Protocol.Chat).some((c) => c.text.toLowerCase().includes(text.toLowerCase()));
  }

  create(settings: Partial<RoomSettings> = { maxPlayers: 8 }, name = "Test room"): string {
    const res = this.w.run((fx) => this.r.createRoom(this.conn, { name, settings, levels: this.levels.map((l) => l.entry) }, fx));
    expect(res.ok, res.error).toBe(true);
    return res.roomId;
  }

  tryJoin(roomId: string, password = "") {
    return this.w.run((fx) => this.r.joinRoom(this.conn, { roomId, password, levels: this.levels.map((l) => l.entry) }, fx));
  }

  join(roomId: string, password = ""): void {
    const res = this.tryJoin(roomId, password);
    expect(res.ok, res.error).toBe(true);
  }

  pickLocal(level: TestLevel) {
    return this.w.run((fx) => this.r.selectSong(this.conn, { source: Protocol.SourceLocal, hash: level.hash, stars: 4.2 }, fx));
  }

  pickOfficial(hash: string) {
    return this.w.run((fx) => this.r.selectSong(this.conn, { source: Protocol.SourceOfficial, hash }, fx));
  }

  ready(ready = true) {
    return this.w.run((fx) => this.r.setReady(this.conn, ready, fx));
  }

  settings(s: Partial<RoomSettings>) {
    return this.w.run((fx) => this.r.updateSettings(this.conn, s, fx));
  }

  loaded(matchId: string): void {
    this.w.run((fx) => this.r.matchLoaded(this.conn, matchId, fx));
  }

  finish(matchId: string, score: number, extra: Record<string, unknown> = {}): void {
    this.w.run((fx) => this.r.finishMatch(this.conn, { matchId, score, accuracy: 95, sicks: 10, ...extra }, fx));
  }

  completeDownload(transferId: string, ok = true, error: string | null = null): void {
    this.w.run((fx) => this.r.completeDownload(this.conn, transferId, ok, error, fx));
  }

  levelStatus(hash: string, state: string, progress = 0): void {
    this.w.run((fx) => this.r.setLevelStatus(this.conn, { hash, state, progress }, fx));
  }

  spectate(on: boolean): void {
    this.w.run((fx) => this.r.setSpectate(this.conn, on, fx));
  }

  disconnect(): void {
    this.w.run((fx) => this.r.disconnect(this.conn, fx));
  }
}
