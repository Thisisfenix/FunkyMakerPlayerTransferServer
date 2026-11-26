// Port of RankingTests / EloTests (RoomFlowTests.cs) and a few helper checks.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LeaderboardBook } from "../src/leaderboard-book";
import { Protocol, normalizeKeys, type PlayerResult, type RoundResult } from "../src/protocol";
import { cleanFileName, clean, rankResults, roundHalfEven } from "../src/registry";
import { replayKey } from "../src/replays";
import { hasKnownSignature } from "../src/transfers";

const pr = (o: Partial<PlayerResult>): PlayerResult => ({
  playerId: "",
  username: "",
  colorHue: 180,
  side: 0,
  team: -1,
  score: 0,
  accuracy: 0,
  misses: 0,
  sicks: 0,
  goods: 0,
  bads: 0,
  shits: 0,
  maxCombo: 0,
  place: 0,
  disconnected: false,
  ...o,
});

const round = (o: Partial<RoundResult>): RoundResult => ({
  matchId: randomUUID(),
  mode: Protocol.ModeMirror,
  song: { name: "S" } as RoundResult["song"],
  players: [],
  teamScores: [],
  winningTeam: -1,
  finishedAt: Date.now(),
  ...o,
});

describe("ranking", () => {
  it("teams use the average so uneven teams are fair", () => {
    const results = [pr({ username: "a", team: 0, score: 900 }), pr({ username: "b", team: 0, score: 300 }), pr({ username: "c", team: 1, score: 700 })];
    const r = round({ mode: Protocol.ModeTeams });
    rankResults(results, r);
    expect(r.teamScores).toEqual([600, 700]);
    expect(r.winningTeam).toBe(1);
    expect(results.map((x) => x.username)).toEqual(["a", "c", "b"]);
  });

  it("ties share a place and disconnected players are last", () => {
    const results = [
      pr({ username: "gone", score: 9999, disconnected: true }),
      pr({ username: "x", score: 500 }),
      pr({ username: "y", score: 500 }),
      pr({ username: "z", score: 100 }),
    ];
    rankResults(results, round({}));
    expect(results.map((x) => x.place)).toEqual([1, 1, 3, 4]);
    expect(results.at(-1)!.username).toBe("gone");
  });
});

describe("elo", () => {
  const P = (id: string, place: number, team = -1) => pr({ playerId: id + randomUUID(), username: id, place, team, score: 1000 - place });

  it("mirror: three players pairwise", () => {
    const lb = new LeaderboardBook();
    const r = round({ players: [P("first", 1), P("second", 2), P("third", 3)] });
    expect(lb.recordRound(r)).not.toBeNull();
    expect(lb.recordRound(r)).toBeNull(); // same match id is ignored
    const m = lb.recentMatches(null, 0, 1)[0];
    expect(m.players.map((p) => p.eloChange)).toEqual([16, 0, -16]);
    expect(m.player1.username).toBe("first");
    expect(m.winner).toBe(1);
  });

  it("teams compare only against the other team", () => {
    const lb = new LeaderboardBook();
    const r = round({ mode: Protocol.ModeTeams, winningTeam: 1, players: [P("a", 1, 0), P("b", 2, 1), P("c", 3, 1)] });
    lb.recordRound(r);
    const m = lb.recentMatches(null, 0, 1)[0];
    expect(m.players.find((p) => p.username === "a")!.eloChange).toBe(-16);
    expect(m.players.find((p) => p.username === "b")!.eloChange).toBe(16);
    expect(m.players.find((p) => p.username === "c")!.eloChange).toBe(16);
  });

  it("updates the leaderboard and user directory", () => {
    const lb = new LeaderboardBook();
    const a = P("a", 1),
      b = P("b", 2);
    lb.recordRound(round({ players: [a, b] }));
    const top = lb.topPlayers(0, 10);
    expect(top[0].playerId).toBe(a.playerId);
    expect(top[0].wins).toBe(1);
    expect(top[1].losses).toBe(1);
    lb.upsertConnectedProfile({ playerId: b.playerId, username: "Renamed", colorHue: 10 });
    expect(lb.userById(b.playerId)!.username).toBe("Renamed");
    expect(lb.totalKnownUsers()).toBe(2);
  });

  it("loads the old server's PascalCase JSON", () => {
    const lb = new LeaderboardBook();
    lb.load(
      [{ PlayerId: "p1", Username: "Old", EloRating: 1200, Wins: 3 }],
      [{ MatchId: "m1", LevelName: "L", Timestamp: 10, Player1: { PlayerId: "p1" }, Player2: { PlayerId: "p2" }, Players: [] }],
    );
    expect(lb.topPlayers(0, 1)[0]).toMatchObject({ playerId: "p1", eloRating: 1200, wins: 3 });
    expect(lb.recentMatches("p2", 0, 10)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("rounds like C# Math.Round", () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(-2.5)).toBe(-2);
    expect(roundHalfEven(16.4)).toBe(16);
  });

  it("cleans file names like the old server", () => {
    expect(cleanFileName("C:\\levels\\My Song.fnmm")).toBe("My Song.fnmm");
    expect(cleanFileName("bad<name>.zip")).toBe("bad_name_.zip");
    expect(cleanFileName("song.exe")).toBe("");
    expect(cleanFileName(".fnmm")).toBe("");
    expect(cleanFileName("set.osz", true)).toBe("set.osz");
    expect(cleanFileName("set.fnmm", true)).toBe("");
    expect(clean("  a\u0000b\tc  ", 10)).toBe("abc");
  });

  it("normalizes PascalCase keys", () => {
    expect(normalizeKeys({ PlayerId: "x", Levels: [{ Hash: "h" }] })).toEqual({ playerId: "x", levels: [{ hash: "h" }] });
  });

  it("validates replay keys and archive signatures", () => {
    const lvl = "a".repeat(64);
    expect(replayKey("p-1", "p-2", lvl.toUpperCase())).toBe(`replays/p-1/p-2/${lvl}.gz`);
    expect(replayKey("../x", "p", lvl)).toBeNull();
    expect(replayKey("p", "o", "nothex")).toBeNull();
    expect(hasKnownSignature(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(hasKnownSignature(new Uint8Array([0x52, 0x61, 0x72, 0x21]))).toBe(true);
    expect(hasKnownSignature(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
});
