// Port of tests/FunkyMakerTransferServer.Tests/RoomFlowTests.cs, run directly against the registry
// (fake clock, simulated R2 uploads) instead of a live SignalR server.

import { describe, expect, it } from "vitest";
import { Protocol, type MatchInfo, type RoundResult, type TransferDownloadPacket, type TransferUploadPacket } from "../src/protocol";
import { SilenceTimeoutMs, CountdownMs, Effects } from "../src/registry";
import { TestLevel, World, sha256, type TestPlayer } from "./helpers";

const upload = (p: TestPlayer, pred: (u: TransferUploadPacket) => boolean = () => true) =>
  p.all<TransferUploadPacket>(Protocol.TransferUpload).filter(pred).at(-1)!;
const download = (p: TestPlayer) => p.latest<TransferDownloadPacket>(Protocol.TransferDownload)!;
const matchInfo = (p: TestPlayer) => p.latest<MatchInfo>(Protocol.MatchLoading)!;

function startMatch(w: World, picker: TestPlayer, lvl: TestLevel, players: TestPlayer[]): MatchInfo {
  expect(picker.pickLocal(lvl).ok).toBe(true);
  for (const p of players) if (p !== picker) expect(p.ready().ok).toBe(true);
  const info = matchInfo(picker);
  for (const p of players) p.loaded(info.matchId);
  expect(picker.latest(Protocol.MatchStart)).toBeDefined();
  w.time = picker.latest<{ startTimestamp: number }>(Protocol.MatchStart)!.startTimestamp; // countdown over
  return info;
}

describe("session / browser", () => {
  it("refuses old protocols with an update message", () => {
    const w = new World();
    const r = w.run((fx) => w.registry.hello("c", { username: "Old", protocolVersion: 3 }, fx));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Update the game");
  });

  it("lists rooms and checks the password", () => {
    const w = new World();
    const a = w.connect("Alice");
    const b = w.connect("Bob");
    const id = a.create({ mode: Protocol.ModeTeams, maxPlayers: 4, password: "secret" }, "Alice's party");

    const list = w.registry.listRooms();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "Alice's party", hasPassword: true, mode: "teams", hostName: "Alice", playerCount: 1, maxPlayers: 4 });

    const wrong = b.tryJoin(id, "nope");
    expect(wrong.ok).toBe(false);
    expect(wrong.error.toLowerCase()).toContain("password");
    b.join(id, "secret");

    expect(b.state.settings.password).toBe("");
    expect(b.state.hasPassword).toBe(true);
    expect(a.state.settings.password).toBe("secret");
    expect(b.state.members.map((m) => m.username)).toEqual(["Alice", "Bob"]);
    expect(b.state.members[0].isHost).toBe(true);
    expect(a.chatHas("Bob joined")).toBe(true);
  });

  it("refuses joins to a full room", () => {
    const w = new World();
    const [a, b, c] = [w.connect("A"), w.connect("B"), w.connect("C")];
    const id = a.create({ maxPlayers: 2 });
    b.join(id);
    const r = c.tryJoin(id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("full");
  });

  it("follows MaxRoomMembers for the player limit (default 8)", () => {
    const w = new World({ maxRoomMembers: 12 });
    const a = w.connect("A");
    expect(w.run((fx) => w.registry.hello(a.conn, { playerId: a.playerId, username: "A", protocolVersion: Protocol.Version }, fx)).maxRoomPlayers).toBe(12);
    expect(w.run((fx) => w.registry.createRoom(a.conn, { settings: { maxPlayers: 13 } }, fx)).ok).toBe(false);
    a.create({ maxPlayers: 12 });
    expect(a.state.settings.maxPlayers).toBe(12);

    const w8 = new World();
    const x = w8.connect("X");
    expect(w8.run((fx) => w8.registry.createRoom(x.conn, { settings: { maxPlayers: 9 } }, fx)).ok).toBe(false);
  });

  it("a reconnect from another window takes over the place in the room", () => {
    const w = new World();
    const a = w.connect("A");
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    // Same player id on a new connection.
    const b2 = w.connect("B");
    (b2 as { playerId: string }).playerId = b.playerId;
    w.run((fx) => w.registry.hello(b2.conn, { playerId: b.playerId, username: "B", protocolVersion: Protocol.Version }, fx));
    b2.join(id);
    expect(b.latest(Protocol.Kicked)).toBeDefined();
    expect(b2.state.members).toHaveLength(2);
  });
});

describe("round flow", () => {
  it("plays a full round with a shared level, ranks players and passes the turn", () => {
    const w = new World();
    const lvl = TestLevel.create("Shared");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const id = a.create();
    b.join(id);

    expect(b.state.turnPlayerId).toBe(a.playerId);
    expect(b.pickLocal(lvl).ok).toBe(false);

    expect(a.pickLocal(lvl).ok).toBe(true);
    let s = b.state;
    expect(s.phase).toBe(Protocol.PhaseSongSelected);
    expect(s.song!.name).toBe("Shared");
    expect(s.song!.stars).toBeCloseTo(4.2);
    expect(s.members.find((m) => m.id === a.playerId)!.status).toBe(Protocol.StatusReady);
    expect(s.members.find((m) => m.id === b.playerId)!.levelStatus).toBe(Protocol.LevelReady);
    expect(s.startBlocker).toContain("B");

    expect(b.ready().ok).toBe(true);
    const info = matchInfo(a);
    expect(info.players.map((p) => p.side).sort()).toEqual([0, 1]);

    a.loaded(info.matchId);
    expect(b.state.match!.loaded).toContain(a.playerId);
    expect(b.state.match!.loaded).not.toContain(b.playerId);
    b.loaded(info.matchId);
    const start = b.latest<{ startTimestamp: number }>(Protocol.MatchStart)!;
    expect(start.startTimestamp).toBeGreaterThan(w.time + 2000);
    expect(a.state.phase).toBe(Protocol.PhasePlaying);

    const relay = w.registry.relay(a.conn)!;
    expect(relay.playerId).toBe(a.playerId);
    expect(relay.targets).toEqual([b.conn]);

    a.finish(info.matchId, 5000, { accuracy: 95, misses: 2 });
    expect(a.all(Protocol.MatchResults)).toHaveLength(0);
    b.finish(info.matchId, 7000, { accuracy: 98 });

    const result = a.latest<RoundResult>(Protocol.MatchResults)!;
    expect(result.players[0].username).toBe("B");
    expect(result.players.map((p) => p.place)).toEqual([1, 2]);
    s = a.state;
    expect(s.phase).toBe(Protocol.PhaseLobby);
    expect(s.history).toHaveLength(1);
    expect(s.turnPlayerId).toBe(b.playerId);
    expect(s.song).toBeNull();
    expect(a.chatHas("B wins Shared with 7,000 points")).toBe(true);
    expect(w.rounds).toHaveLength(1);
  });

  it("uploads a local level once and everybody who lacks it downloads it", () => {
    const w = new World();
    const lvl = TestLevel.create("OnlyHost", 400_000);
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const c = w.connect("C");
    const id = a.create({ mode: Protocol.ModeTeams, maxPlayers: 4 });
    b.join(id);
    c.join(id);

    expect(a.pickLocal(lvl).ok).toBe(true);
    const up = upload(a);
    expect(up.hash).toBe(lvl.hash);
    expect(up.size).toBe(lvl.bytes.length);
    expect(w.upload(up.transferId, up.token, lvl.bytes).ok).toBe(true);

    for (const p of [b, c]) {
      const down = download(p);
      expect(down.fileHash).toBe(lvl.hash);
      expect(w.registry.beginDownload(down.transferId, down.token).ok).toBe(true);
      p.completeDownload(down.transferId);
    }
    expect(a.all(Protocol.TransferUpload)).toHaveLength(1);
    expect(a.state.members.every((m) => m.levelStatus === Protocol.LevelReady)).toBe(true);
    expect(a.state.startBlocker).toContain("ready");
    b.ready();
    c.ready();
    const info = matchInfo(a);
    expect(info.players).toHaveLength(3);
    expect(info.players.some((p) => p.team === 0)).toBe(true);
    expect(info.players.some((p) => p.team === 1)).toBe(true);
  });

  it("chunked upload with an idempotent retry completes and becomes downloadable", () => {
    const w = new World({ uploadChunkMegabytes: 5 });
    const chunk = w.registry.uploadChunkBytes;
    const lvl = TestLevel.create("Chunked", chunk * 2 + 1234);
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    a.pickLocal(lvl);
    const up = upload(a);
    const r = w.registry;

    // Misaligned offsets are refused (R2 parts must all be the same size).
    const bad = r.beginChunkUpload(up.transferId, up.token, 0, chunk + 1);
    expect(bad.ok).toBe(false);

    const send = (offset: number) => {
      const len = Math.min(chunk, lvl.bytes.length - offset);
      const t = r.beginChunkUpload(up.transferId, up.token, offset, len);
      expect(t.ok, t.ok ? "" : t.error).toBe(true);
      if (!t.ok) return;
      if (!t.ticket.uploadId) r.setMultipartUploadId(up.transferId, t.ticket.key, "mp");
      // Only one chunk at a time.
      expect(r.beginChunkUpload(up.transferId, up.token, offset, len).ok).toBe(false);
      w.run((fx) => r.finishChunkUpload(up.transferId, t.ticket.partNumber, "e" + t.ticket.partNumber, len, fx));
    };
    send(0);
    send(chunk);
    send(chunk); // retry of the same part
    send(chunk * 2);
    const c = r.beginCompleteChunkedUpload(up.transferId, up.token);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.ticket.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(c.ticket.totalBytes).toBe(lvl.bytes.length);
    expect(c.ticket.expectedHash).toBe(lvl.hash);
    expect(w.run((fx) => r.completeUpload(up.transferId, c.ticket.key, lvl.hash, c.ticket.totalBytes, fx)).ok).toBe(true);
    expect(download(b)).toBeDefined();
  });

  it("a mismatching upload fails and the transfer is retried by the next holder", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const c = w.connect("C");
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    a.pickLocal(lvl);
    const up = upload(a);
    const res = w.upload(up.transferId, up.token, lvl.bytes, { hash: "0".repeat(64) });
    expect(res.ok).toBe(false);
    expect(w.deleted.length).toBeGreaterThan(0);
    expect(upload(b)).toBeDefined(); // B has the level too: asked to send it instead
  });

  it("osu! sets are packed once per variant and sent to whoever lacks them", () => {
    const w = new World();
    const osu = TestLevel.osu("Lagtrain", 3_000_000, 1_000_000);
    const a = w.connect("A", [osu]);
    const b = w.connect("B");
    const c = w.connect("C", [], { osuSkipVideo: true });
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 4 });
    b.join(id);
    c.join(id);

    const listed = b.state.levels!.find((l) => l.hash === osu.hash)!;
    expect(listed).toMatchObject({ kind: "osu", setId: "set-lagtrain", difficulty: "Hard", sizeNoVideo: 1_000_000 });

    expect(a.pickLocal(osu).ok).toBe(true);
    const full = upload(a, (u) => u.variant === Protocol.VariantFull);
    const noVideo = upload(a, (u) => u.variant === Protocol.VariantNoVideo);
    expect(full.kind).toBe("osu");
    expect(full.size).toBe(0);
    expect(full.maxSize).toBeGreaterThan(3_000_000);
    const fullBytes = TestLevel.package(200_000);
    const smallBytes = TestLevel.package(50_000);
    expect(w.upload(full.transferId, full.token, fullBytes).ok).toBe(true);
    expect(w.upload(noVideo.transferId, noVideo.token, smallBytes).ok).toBe(true);

    for (const [p, bytes, variant] of [
      [b, fullBytes, Protocol.VariantFull],
      [c, smallBytes, Protocol.VariantNoVideo],
    ] as const) {
      const down = download(p);
      expect(down.variant).toBe(variant);
      expect(down.hash).toBe(osu.hash);
      expect(down.size).toBe(bytes.length);
      expect(down.fileHash).toBe(sha256(bytes));
      p.completeDownload(down.transferId);
    }
    expect(a.all(Protocol.TransferUpload)).toHaveLength(2);
    expect(a.state.members.every((m) => m.levelStatus === Protocol.LevelReady)).toBe(true);
    expect(a.state.levels!.find((l) => l.hash === osu.hash)!.holders).toHaveLength(2);
  });

  it("FNF chart-only variant is sent separately and doesn't make the receiver a full holder", () => {
    const w = new World();
    const lvl = TestLevel.create("HeavyFnf", 400_000);
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const c = w.connect("C", [], { fnfChartOnly: true });
    const id = a.create({ mode: Protocol.ModeTeams, maxPlayers: 4 });
    b.join(id);
    c.join(id);
    a.pickLocal(lvl);
    const fullUp = upload(a, (u) => u.variant === Protocol.VariantFull);
    const chartUp = upload(a, (u) => u.variant === Protocol.VariantChartOnly);
    expect(fullUp.size).toBe(lvl.bytes.length);
    expect(chartUp.size).toBe(0);
    const chartBytes = TestLevel.package(30_000);
    w.upload(fullUp.transferId, fullUp.token, lvl.bytes);
    w.upload(chartUp.transferId, chartUp.token, chartBytes);
    const bDown = download(b);
    const cDown = download(c);
    expect(bDown.variant).toBe(Protocol.VariantFull);
    expect(cDown.variant).toBe(Protocol.VariantChartOnly);
    expect(cDown.size).toBe(chartBytes.length);
    b.completeDownload(bDown.transferId);
    c.completeDownload(cDown.transferId);
    expect(a.state.members.every((m) => m.levelStatus === Protocol.LevelReady)).toBe(true);
    const holders = a.state.levels!.find((l) => l.hash === lvl.hash)!.holders;
    expect(holders).toEqual([b.playerId]);
  });

  it("song types limit what can be picked", () => {
    const w = new World();
    const fnf = TestLevel.create("Fnf");
    const osu = TestLevel.osu("Mania");
    const official = w.addOfficial("Official");
    const a = w.connect("A", [fnf, osu]);
    const b = w.connect("B");
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 2, songTypes: Protocol.SongTypesFnf });
    b.join(id);
    const st = b.state;
    expect(st.levels!.find((l) => l.kind === "fnf")!.pickable).toBe(true);
    expect(st.levels!.find((l) => l.kind === "osu")!.pickable).toBe(false);
    expect(a.pickLocal(osu).ok).toBe(false);
    expect(a.pickLocal(fnf).ok).toBe(true);

    expect(a.settings({ mode: Protocol.ModeMirror, maxPlayers: 2, songTypes: Protocol.SongTypesOsu }).ok).toBe(true);
    expect(b.chatHas("song types")).toBe(true);
    expect(b.chatHas("cleared")).toBe(true);
    expect(a.pickLocal(fnf).ok).toBe(false);
    expect(a.pickOfficial(official.hash).ok).toBe(false);
    expect(a.pickLocal(osu).ok).toBe(true);

    expect(a.settings({ mode: Protocol.ModeMirror, maxPlayers: 2, songTypes: "weird" }).ok).toBe(true);
    expect(b.state.settings.songTypes).toBe(Protocol.SongTypesBoth);
  });

  it("osu! songs are only played in Mirror rooms", () => {
    const w = new World();
    const osu = TestLevel.osu("Mania");
    const a = w.connect("A", [osu]);
    const b = w.connect("B");
    const id = a.create({ mode: Protocol.ModeVersus, maxPlayers: 2 });
    b.join(id);
    expect(b.state.levels![0].pickable).toBe(false);
    const pick = a.pickLocal(osu);
    expect(pick.ok).toBe(false);
    expect(pick.error).toContain("Mirror");
    expect(a.settings({ mode: Protocol.ModeVersus, maxPlayers: 2, songTypes: Protocol.SongTypesOsu }).ok).toBe(false);
    expect(a.settings({ mode: Protocol.ModeMirror, maxPlayers: 2 }).ok).toBe(true);
    expect(a.pickLocal(osu).ok).toBe(true);
    expect(a.settings({ mode: Protocol.ModeTeams, maxPlayers: 2 }).ok).toBe(true);
    expect(b.chatHas("cleared")).toBe(true);
  });

  it("ready requires the level, and a picked song can't be changed", () => {
    const w = new World();
    const one = TestLevel.create("One");
    const two = TestLevel.create("Two");
    const a = w.connect("A", [one, two]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    expect(a.pickLocal(one).ok).toBe(true);
    expect(b.ready().ok).toBe(false);
    const again = a.pickLocal(two);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("can't be changed");
  });

  it("official levels need the client to report them ready", () => {
    const w = new World();
    const off = w.addOfficial("Spirit Dance");
    const a = w.connect("A");
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    expect(a.pickOfficial(off.hash).ok).toBe(true);
    expect(b.state.song!.officialId).toBe("spirit dance");
    expect(b.state.members.find((m) => m.id === b.playerId)!.levelStatus).toBe(Protocol.LevelMissing);
    b.levelStatus(off.hash, Protocol.LevelDownloading, 0.5);
    expect(a.state.members.find((m) => m.id === b.playerId)!.levelProgress).toBe(0.5);
    a.levelStatus(off.hash, Protocol.LevelReady);
    b.levelStatus(off.hash, Protocol.LevelReady);
    expect(b.ready().ok).toBe(true);
    expect(matchInfo(a)).toBeDefined();
  });

  it("versus with three players is blocked until one spectates", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const [a, b, c] = [w.connect("A", [lvl]), w.connect("B", [lvl]), w.connect("C", [lvl])];
    const id = a.create({ mode: Protocol.ModeVersus, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    a.pickLocal(lvl);
    b.ready();
    c.ready();
    expect(a.state.startBlocker).toContain("Versus needs exactly 2");
    expect(a.all(Protocol.MatchLoading)).toHaveLength(0);
    c.spectate(true);
    const info = matchInfo(a);
    expect(info.players.some((p) => p.playerId === c.playerId)).toBe(false);
    expect(matchInfo(c)).toBeDefined();
    expect(c.state.members.find((m) => m.id === c.playerId)!.status).toBe(Protocol.StatusSpectating);
    expect(c.state.members.find((m) => m.id === a.playerId)!.status).toBe(Protocol.StatusPlaying);
  });

  it("mirror majority vote picks the side for everybody", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const [a, b, c] = [w.connect("A", [lvl]), w.connect("B", [lvl]), w.connect("C", [lvl])];
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    a.pickLocal(lvl);
    w.run((fx) => w.registry.voteSide(a.conn, 0, fx));
    w.run((fx) => w.registry.voteSide(b.conn, 1, fx));
    w.run((fx) => w.registry.voteSide(c.conn, 1, fx));
    b.ready();
    c.ready();
    const info = matchInfo(a);
    expect(info.mirrorSide).toBe(1);
    expect(info.players.every((p) => p.side === 1)).toBe(true);
  });

  it("turns skip spectators; host-only rooms always give the host the turn", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const [a, b, c] = [w.connect("A", [lvl]), w.connect("B", [lvl]), w.connect("C", [lvl])];
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    b.spectate(true);
    const info = startMatch(w, a, lvl, [a, c]);
    a.finish(info.matchId, 1100);
    c.finish(info.matchId, 1200);
    expect(a.state.turnPlayerId).toBe(c.playerId);
    expect(a.settings({ mode: Protocol.ModeMirror, songSelection: Protocol.SelectHost, maxPlayers: 3 }).ok).toBe(true);
    expect(a.state.turnPlayerId).toBe(a.playerId);
    expect(c.chatHas("song selection → host only")).toBe(true);
  });

  it("host can kick; the kicked player can't rejoin for a while", () => {
    const w = new World();
    const a = w.connect("A");
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    expect(w.run((fx) => w.registry.kick(b.conn, a.playerId, fx)).ok).toBe(false);
    expect(w.run((fx) => w.registry.kick(a.conn, b.playerId, fx)).ok).toBe(true);
    expect(b.latest(Protocol.Kicked)).toBeDefined();
    expect(a.chatHas("B was kicked")).toBe(true);
    const again = b.tryJoin(id);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("kicked");
    w.advance(5 * 60_000 + 1000);
    expect(b.tryJoin(id).ok).toBe(true);
  });

  it("the host leaving hands the room to the next player", () => {
    const w = new World();
    const [a, b, c] = [w.connect("A"), w.connect("B"), w.connect("C")];
    const id = a.create();
    b.join(id);
    c.join(id);
    w.run((fx) => w.registry.leaveRoom(a.conn, fx));
    expect(c.state.members).toHaveLength(2);
    expect(c.state.hostId).toBe(b.playerId);
    expect(c.state.turnPlayerId).toBe(b.playerId);
    expect(c.chatHas("B is the new host")).toBe(true);
  });

  it("guests can only pick official / host levels when guest levels are off", () => {
    const w = new World();
    const hostLvl = TestLevel.create("HostLvl");
    const guestLvl = TestLevel.create("GuestLvl");
    const a = w.connect("A", [hostLvl]);
    const b = w.connect("B", [guestLvl]);
    const id = a.create({ allowGuestLocalLevels: false, maxPlayers: 2 });
    b.join(id);
    const levels = new Map(b.state.levels!.map((l) => [l.hash, l]));
    expect(levels.get(hostLvl.hash)!.pickable).toBe(true);
    expect(levels.get(guestLvl.hash)!.pickable).toBe(false);
    const r = a.pickLocal(guestLvl);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("official");
  });

  it("settings can't change during a match and changes are announced", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const id = a.create({ maxPlayers: 4 });
    b.join(id);
    expect(a.settings({ mode: Protocol.ModeTeams, maxPlayers: 6, password: "pw" }).ok).toBe(true);
    expect(b.chatHas("mode → Teams")).toBe(true);
    expect(b.chatHas("password protected")).toBe(true);
    expect(a.settings({ mode: Protocol.ModeTeams, maxPlayers: 1 }).ok).toBe(false);
    a.pickLocal(lvl);
    b.ready();
    expect(matchInfo(a)).toBeDefined();
    expect(a.settings({ mode: Protocol.ModeMirror, maxPlayers: 6 }).ok).toBe(false);
  });

  it("quitting while loading takes the player out of the match", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const [a, b, c] = [w.connect("A", [lvl]), w.connect("B", [lvl]), w.connect("C", [lvl])];
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    a.pickLocal(lvl);
    b.ready();
    c.ready();
    const info = matchInfo(a);
    a.loaded(info.matchId);
    c.loaded(info.matchId);
    b.finish(info.matchId, 0, { quit: true });
    expect(a.latest(Protocol.MatchStart)).toBeDefined();
    const st = a.state;
    expect(st.phase).toBe(Protocol.PhasePlaying);
    expect(st.members.find((m) => m.id === b.playerId)!.status).toBe(Protocol.StatusSpectating);
    expect(st.match!.players.some((p) => p.playerId === b.playerId)).toBe(false);
  });

  it("a silent player is dropped and the round ends", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const id = a.create();
    b.join(id);
    const info = startMatch(w, a, lvl, [a, b]);
    a.finish(info.matchId, 100, { sicks: 1 });
    w.advance(SilenceTimeoutMs + 1000);
    expect(a.chatHas("stopped responding")).toBe(true);
    const result = a.latest<RoundResult>(Protocol.MatchResults)!;
    expect(result.players.find((p) => p.username === "B")!.disconnected).toBe(true);
    expect(a.state.phase).toBe(Protocol.PhaseLobby);
    expect(CountdownMs).toBe(4000);
  });

  it("nothing judged is 0 %, not 100 %", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const id = a.create();
    b.join(id);
    const info = startMatch(w, a, lvl, [a, b]);
    a.finish(info.matchId, 0, { accuracy: 100, sicks: 0 });
    b.finish(info.matchId, 50, { accuracy: 90, sicks: 9, misses: 1 });
    const result = a.latest<RoundResult>(Protocol.MatchResults)!;
    expect(result.players.find((p) => p.username === "A")!.accuracy).toBe(0);
    expect(result.players.find((p) => p.username === "B")!.accuracy).toBe(90);
  });

  it("disconnect mid-match still finishes the round with the last known score", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const id = a.create();
    b.join(id);
    const info = startMatch(w, a, lvl, [a, b]);
    w.registry.recordState(b.conn, { playerId: "", score: 1234, combo: 0, maxCombo: 0, accuracy: 0, sicks: 0, goods: 0, bads: 0, shits: 0, misses: 0, songTime: 1, left: false });
    b.disconnect();
    a.finish(info.matchId, 100);
    const result = a.latest<RoundResult>(Protocol.MatchResults)!;
    const bRes = result.players.find((p) => p.username === "B")!;
    expect(bRes.disconnected).toBe(true);
    expect(bRes.score).toBe(1234);
    expect(bRes.place).toBe(2);
  });

  it("exit match marks the player as left and announces it", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const [a, b, c] = [w.connect("A", [lvl]), w.connect("B", [lvl]), w.connect("C", [lvl])];
    const id = a.create({ mode: Protocol.ModeMirror, maxPlayers: 3 });
    b.join(id);
    c.join(id);
    const info = startMatch(w, a, lvl, [a, b, c]);
    b.finish(info.matchId, 99999, { quit: true });
    expect(a.chatHas("B left the match")).toBe(true);
    expect(a.all(Protocol.MatchResults)).toHaveLength(0);
    expect(c.state.members.find((m) => m.id === b.playerId)!.status).toBe(Protocol.StatusLeftMatch);
    a.finish(info.matchId, 500);
    expect(c.state.members.find((m) => m.id === a.playerId)!.status).toBe(Protocol.StatusFinished);
    expect(c.state.members.find((m) => m.id === c.playerId)!.status).toBe(Protocol.StatusPlaying);
    c.finish(info.matchId, 400);
    const result = a.latest<RoundResult>(Protocol.MatchResults)!;
    expect(result.players.at(-1)!.username).toBe("B");
    expect(result.players[0].username).toBe("A");
  });

  it("a mid-match joiner spectates and gets the level", () => {
    const w = new World();
    const lvl = TestLevel.create("Lvl");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B", [lvl]);
    const c = w.connect("C");
    const id = a.create();
    b.join(id);
    startMatch(w, a, lvl, [a, b]);
    c.join(id);
    const s = c.state;
    expect(s.phase).toBe(Protocol.PhasePlaying);
    expect(s.match!.startTimestamp).toBeGreaterThan(0);
    expect(s.members.find((m) => m.id === c.playerId)!.status).toBe(Protocol.StatusSpectating);
    const up = upload(a);
    w.upload(up.transferId, up.token, lvl.bytes);
    expect(download(c).fileHash).toBe(lvl.hash);
    expect(w.registry.relay(a.conn)!.targets).toContain(c.conn);
  });

  it("chat is broadcast and new members get the history", () => {
    const w = new World();
    const a = w.connect("A");
    const b = w.connect("B");
    const id = a.create();
    w.run((fx) => w.registry.chat(a.conn, "hello there", fx));
    b.join(id);
    const msg = b.all<{ text: string; username: string; system: boolean }>(Protocol.Chat).find((m) => m.text === "hello there")!;
    expect(msg.username).toBe("A");
    expect(msg.system).toBe(false);
  });

  it("downloads use the completion grace once the client reported 100 %, and a late CompleteDownload still recovers", () => {
    const w = new World({ stallTimeoutSeconds: 1, downloadCompletionGraceSeconds: 10 });
    const lvl = TestLevel.create("SlowPhone", 200_000);
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    a.pickLocal(lvl);
    const up = upload(a);
    w.upload(up.transferId, up.token, lvl.bytes);
    const down = download(b);
    w.registry.beginDownload(down.transferId, down.token);
    b.levelStatus(lvl.hash, Protocol.LevelDownloading, 1);
    w.advance(1500);
    expect(b.all(Protocol.TransferFailed)).toHaveLength(0);

    w.advance(10_000);
    expect(b.all(Protocol.TransferFailed)).toHaveLength(1);
    b.completeDownload(down.transferId);
    expect(a.state.members.find((m) => m.id === b.playerId)!.levelStatus).toBe(Protocol.LevelReady);
  });

  it("a stalled upload times out and the room is told", () => {
    const w = new World({ stallTimeoutSeconds: 5 });
    const lvl = TestLevel.create("Stuck");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    a.pickLocal(lvl);
    w.advance(6000);
    expect(b.latest<{ reason: string }>(Protocol.TransferFailed)!.reason).toContain("timed out");
  });

  it("an emptied room deletes its cached files from R2", () => {
    const w = new World();
    const lvl = TestLevel.create("Cached");
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    a.pickLocal(lvl);
    const up = upload(a);
    w.upload(up.transferId, up.token, lvl.bytes);
    const before = w.deleted.length;
    b.disconnect();
    a.disconnect();
    expect(w.deleted.length).toBe(before + 1);
    expect(w.registry.hasActivity()).toBe(false);
  });

  it("cancelling a chunked upload aborts the R2 multipart upload", () => {
    const w = new World();
    const lvl = TestLevel.create("Abort", 300_000);
    const a = w.connect("A", [lvl]);
    const b = w.connect("B");
    const id = a.create();
    b.join(id);
    a.pickLocal(lvl);
    const up = upload(a);
    const t = w.registry.beginChunkUpload(up.transferId, up.token, 0, lvl.bytes.length);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    w.registry.setMultipartUploadId(up.transferId, t.ticket.key, "mp");
    a.disconnect();
    expect(w.aborted).toContain(t.ticket.key);
  });

  it("effects start empty", () => {
    expect(new Effects().messages).toHaveLength(0);
  });
});
