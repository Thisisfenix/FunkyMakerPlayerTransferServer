// Port of Official/Services/LeaderboardService.cs: the pure logic (no Cloudflare APIs, unit-tested).
// leaderboard.ts persists it in a SQLite-backed Durable Object.

import { Protocol, normalizeKeys, str, num, int, bool } from "./protocol";
import { roundHalfEven, newId } from "./registry";
import type { RoundResult } from "./protocol";

export const MaxStoredMatches = 1000;
export const EloK = 32;

export interface LeaderboardEntry {
  playerId: string;
  username: string;
  avatarIndex: number;
  colorHue: number;
  totalScore: number;
  wins: number;
  losses: number;
  draws: number;
  highestScore: number;
  highestCombo: number;
  bestAccuracy: number;
  eloRating: number;
  lastPlayedTimestamp: number;
  createdTimestamp: number;
}

export interface PlayerMatchData {
  playerId: string;
  username: string;
  avatarIndex: number;
  colorHue: number;
  score: number;
  accuracy: number;
  maxCombo: number;
  misses: number;
  disconnected: boolean;
  place: number;
  team: number;
  side: number;
  eloChange: number;
}

export interface MatchHistory {
  matchId: string;
  levelName: string;
  player1: PlayerMatchData;
  player2: PlayerMatchData;
  winner: number;
  durationSeconds: number;
  timestamp: number;
  mode: string;
  players: PlayerMatchData[];
  winningTeam: number;
}

export interface UserDirectoryEntry {
  playerId: string;
  username: string;
  avatarIndex: number;
  colorHue: number;
  eloRating: number;
  wins: number;
  losses: number;
  draws: number;
  lastSeenTimestamp: number;
}

export interface ConnectedProfile {
  playerId: string;
  username: string;
  colorHue: number;
  avatarIndex?: number;
  clientVersion?: string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function emptyPlayerData(): PlayerMatchData {
  return {
    playerId: "",
    username: "",
    avatarIndex: 0,
    colorHue: 180,
    score: 0,
    accuracy: 0,
    maxCombo: 0,
    misses: 0,
    disconnected: false,
    place: 0,
    team: -1,
    side: 0,
    eloChange: 0,
  };
}

export function toEntry(raw: unknown): LeaderboardEntry | null {
  const r = normalizeKeys(raw) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const playerId = str(r.playerId).trim();
  if (!playerId) return null;
  return {
    playerId,
    username: str(r.username, "Player"),
    avatarIndex: int(r.avatarIndex),
    colorHue: int(r.colorHue, 180),
    totalScore: num(r.totalScore),
    wins: int(r.wins),
    losses: int(r.losses),
    draws: int(r.draws),
    highestScore: num(r.highestScore),
    highestCombo: int(r.highestCombo),
    bestAccuracy: num(r.bestAccuracy),
    eloRating: int(r.eloRating, 1000),
    lastPlayedTimestamp: num(r.lastPlayedTimestamp),
    createdTimestamp: num(r.createdTimestamp),
  };
}

function toPlayerData(raw: unknown): PlayerMatchData {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    playerId: str(r.playerId),
    username: str(r.username),
    avatarIndex: int(r.avatarIndex),
    colorHue: int(r.colorHue, 180),
    score: num(r.score),
    accuracy: num(r.accuracy),
    maxCombo: int(r.maxCombo),
    misses: int(r.misses),
    disconnected: bool(r.disconnected),
    place: int(r.place),
    team: int(r.team, -1),
    side: int(r.side),
    eloChange: int(r.eloChange),
  };
}

export function toMatch(raw: unknown): MatchHistory | null {
  const r = normalizeKeys(raw) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const matchId = str(r.matchId).trim();
  if (!matchId) return null;
  return {
    matchId,
    levelName: str(r.levelName),
    player1: toPlayerData(r.player1),
    player2: toPlayerData(r.player2),
    winner: int(r.winner),
    durationSeconds: int(r.durationSeconds),
    timestamp: num(r.timestamp),
    mode: str(r.mode),
    players: Array.isArray(r.players) ? r.players.map(toPlayerData) : [],
    winningTeam: int(r.winningTeam, -1),
  };
}

const clone = <T>(x: T): T => structuredClone(x);

export interface RecordOutcome {
  match: MatchHistory;
  players: LeaderboardEntry[];
  droppedMatchId: string | null;
}

/** In-memory leaderboard + match history + user directory (pure logic). */
export class LeaderboardBook {
  players = new Map<string, LeaderboardEntry>();
  /** Newest first, at most MaxStoredMatches. */
  matches: MatchHistory[] = [];
  recordedIds = new Set<string>();
  profiles = new Map<string, UserDirectoryEntry>();

  load(players: unknown[], matches: unknown[], profiles: unknown[] = []): void {
    this.players.clear();
    for (const p of players) {
      const e = toEntry(p);
      if (e) this.players.set(e.playerId, e);
    }
    this.matches = matches
      .map(toMatch)
      .filter((m): m is MatchHistory => m !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MaxStoredMatches);
    this.recordedIds = new Set(this.matches.map((m) => m.matchId));
    this.profiles.clear();
    for (const raw of profiles) {
      const p = raw as UserDirectoryEntry;
      if (p && p.playerId) this.profiles.set(p.playerId, p);
    }
  }

  topPlayers(skip: number, take: number): LeaderboardEntry[] {
    return [...this.players.values()]
      .sort((a, b) => b.eloRating - a.eloRating || b.totalScore - a.totalScore)
      .slice(skip, skip + take)
      .map(clone);
  }

  recentMatches(playerId: string | null, skip: number, take: number): MatchHistory[] {
    let list = this.matches;
    if (playerId)
      list = list.filter(
        (m) => m.player1.playerId === playerId || m.player2.playerId === playerId || m.players.some((p) => p.playerId === playerId),
      );
    return [...list]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(skip, skip + take)
      .map(clone);
  }

  /**
   * Records a finished room round (2+ players) with pairwise ELO: every player is compared with every
   * other player (Versus / Mirror: by place; Teams: by the team result, teammates are not compared),
   * and the change is K * sum(actual - expected) / comparisons. Disconnected players get no stats.
   */
  recordRound(round: RoundResult): RecordOutcome | null {
    const finished = round.players.filter((p) => !p.disconnected);
    if (finished.length < 2) return null;

    const match: MatchHistory = {
      matchId: round.matchId && round.matchId.trim() ? round.matchId : newId(16),
      levelName: round.song.name,
      mode: round.mode,
      winningTeam: round.winningTeam,
      timestamp: round.finishedAt > 0 ? Math.floor(round.finishedAt / 1000) : nowSeconds(),
      durationSeconds: 0,
      player1: emptyPlayerData(),
      player2: emptyPlayerData(),
      winner: 0,
      players: round.players.map((p) => ({
        ...emptyPlayerData(),
        playerId: p.playerId,
        username: p.username,
        colorHue: p.colorHue,
        score: p.score,
        accuracy: p.accuracy,
        maxCombo: p.maxCombo,
        misses: p.misses,
        disconnected: p.disconnected,
        place: p.place,
        team: p.team,
        side: p.side,
      })),
    };
    const teams = round.mode === Protocol.ModeTeams;
    if (this.recordedIds.has(match.matchId)) return null;
    this.recordedIds.add(match.matchId);

    const live = match.players.filter((p) => !p.disconnected);
    const entries = new Map(live.map((p) => [p, this.getOrCreate(p)]));
    const before = new Map(live.map((p) => [p, entries.get(p)!.eloRating]));

    for (const p of live) {
      let sum = 0;
      let comparisons = 0;
      for (const o of live) {
        if (o === p) continue;
        let actual: number;
        if (teams) {
          if (o.team === p.team) continue;
          actual = round.winningTeam < 0 ? 0.5 : round.winningTeam === p.team ? 1 : 0;
        } else {
          actual = p.place < o.place ? 1 : p.place > o.place ? 0 : 0.5;
        }
        const expected = 1 / (1 + Math.pow(10, (before.get(o)! - before.get(p)!) / 400));
        sum += actual - expected;
        comparisons++;
      }
      if (comparisons === 0) continue;
      p.eloChange = roundHalfEven((EloK * sum) / comparisons);
    }

    const firstPlaces = live.filter((x) => x.place === 1).length;
    const changed: LeaderboardEntry[] = [];
    for (const p of live) {
      const player = entries.get(p)!;
      const won = teams ? round.winningTeam >= 0 && p.team === round.winningTeam : p.place === 1 && firstPlaces === 1;
      const draw = teams ? round.winningTeam < 0 : p.place === 1 && firstPlaces > 1;
      applyMatchStats(player, p, won, draw);
      player.eloRating = Math.max(0, player.eloRating + p.eloChange);
      this.players.set(player.playerId, player);
      changed.push(clone(player));
    }

    match.player1 = clone(match.players[0]);
    match.player2 = clone(match.players[1]);
    match.winner =
      match.player1.place < match.player2.place ? 1 : match.player2.place < match.player1.place ? 2 : 0;

    this.matches.unshift(match);
    let dropped: string | null = null;
    if (this.matches.length > MaxStoredMatches) {
      const d = this.matches.pop()!;
      this.recordedIds.delete(d.matchId);
      dropped = d.matchId;
    }
    return { match: clone(match), players: changed, droppedMatchId: dropped };
  }

  private getOrCreate(p: PlayerMatchData): LeaderboardEntry {
    const key = p.playerId.trim() ? p.playerId.trim() : `name:${(p.username.trim() || "unknown").toLowerCase()}`;
    const existing = this.players.get(key);
    if (existing) return existing;
    return {
      playerId: key,
      username: p.username.trim() || "Player",
      avatarIndex: p.avatarIndex,
      colorHue: p.colorHue,
      totalScore: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      highestScore: 0,
      highestCombo: 0,
      bestAccuracy: 0,
      eloRating: 1000,
      lastPlayedTimestamp: 0,
      createdTimestamp: nowSeconds(),
    };
  }

  /** Refreshes a connected player's name; returns the leaderboard entry when it changed. */
  upsertConnectedProfile(profile: ConnectedProfile): { player: LeaderboardEntry | null; directory: UserDirectoryEntry } | null {
    const playerId = (profile.playerId ?? "").trim();
    if (!playerId) return null;
    const cleanName = (profile.username ?? "").trim() || "Player";
    const avatarIndex = profile.avatarIndex ?? 0;
    let changedPlayer: LeaderboardEntry | null = null;
    let elo = 1000,
      wins = 0,
      losses = 0,
      draws = 0;
    const existing = this.players.get(playerId);
    if (existing) {
      elo = existing.eloRating;
      wins = existing.wins;
      losses = existing.losses;
      draws = existing.draws;
      if (existing.username !== cleanName || existing.colorHue !== profile.colorHue || existing.avatarIndex !== avatarIndex) {
        existing.username = cleanName;
        existing.colorHue = profile.colorHue;
        existing.avatarIndex = avatarIndex;
        changedPlayer = clone(existing);
      }
    }
    const directory: UserDirectoryEntry = {
      playerId,
      username: cleanName,
      avatarIndex,
      colorHue: profile.colorHue,
      eloRating: elo,
      wins,
      losses,
      draws,
      lastSeenTimestamp: nowSeconds(),
    };
    this.profiles.set(playerId, directory);
    return { player: changedPlayer, directory };
  }

  private knownUsers(): Map<string, UserDirectoryEntry> {
    const users = new Map<string, UserDirectoryEntry>();
    const merge = (player: PlayerMatchData, ts: number) => {
      if (!player || !player.playerId.trim()) return;
      const id = player.playerId.trim();
      const existing = users.get(id);
      if (!existing) {
        users.set(id, {
          playerId: id,
          username: player.username.trim() || "Player",
          avatarIndex: player.avatarIndex,
          colorHue: player.colorHue,
          eloRating: 1000,
          wins: 0,
          losses: 0,
          draws: 0,
          lastSeenTimestamp: ts,
        });
      } else if (ts >= existing.lastSeenTimestamp && player.username.trim()) {
        existing.username = player.username.trim();
        existing.lastSeenTimestamp = ts;
      }
    };
    for (const m of this.matches) {
      merge(m.player1, m.timestamp);
      merge(m.player2, m.timestamp);
      for (const p of m.players) merge(p, m.timestamp);
    }
    for (const e of this.players.values()) {
      users.set(e.playerId, {
        playerId: e.playerId,
        username: e.username,
        avatarIndex: e.avatarIndex,
        colorHue: e.colorHue,
        eloRating: e.eloRating,
        wins: e.wins,
        losses: e.losses,
        draws: e.draws,
        lastSeenTimestamp: e.lastPlayedTimestamp,
      });
    }
    for (const live of this.profiles.values()) {
      const existing = users.get(live.playerId);
      if (existing) {
        existing.username = live.username;
        existing.avatarIndex = live.avatarIndex;
        existing.colorHue = live.colorHue;
        existing.lastSeenTimestamp = Math.max(existing.lastSeenTimestamp, live.lastSeenTimestamp);
      } else {
        users.set(live.playerId, clone(live));
      }
    }
    return users;
  }

  allUsers(skip: number, take: number): UserDirectoryEntry[] {
    return [...this.knownUsers().values()]
      .sort((a, b) => b.lastSeenTimestamp - a.lastSeenTimestamp || b.eloRating - a.eloRating)
      .slice(Math.max(0, skip), Math.max(0, skip) + Math.min(500, Math.max(1, take)));
  }

  totalKnownUsers(): number {
    return this.knownUsers().size;
  }

  userById(playerId: string): UserDirectoryEntry | null {
    return this.knownUsers().get(playerId.trim()) ?? null;
  }
}

function applyMatchStats(player: LeaderboardEntry, data: PlayerMatchData, won: boolean, draw: boolean): void {
  player.totalScore += data.score;
  player.lastPlayedTimestamp = nowSeconds();
  if (won) player.wins++;
  else if (draw) player.draws++;
  else player.losses++;
  if (data.score > player.highestScore) player.highestScore = data.score;
  if (data.maxCombo > player.highestCombo) player.highestCombo = data.maxCombo;
  if (data.accuracy > player.bestAccuracy) player.bestAccuracy = data.accuracy;
  if (data.username.trim()) player.username = data.username.trim();
  player.colorHue = data.colorHue;
}
