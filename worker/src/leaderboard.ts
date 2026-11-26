// The leaderboard Durable Object: SQLite persistence for LeaderboardBook (leaderboard-book.ts).
// Persistent across deploys, unlike the JSON files on Render's free-plan disk.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { RoundResult } from "./protocol";
import { str } from "./protocol";
import {
  LeaderboardBook,
  MaxStoredMatches,
  toEntry,
  toMatch,
  type ConnectedProfile,
  type LeaderboardEntry,
  type MatchHistory,
  type UserDirectoryEntry,
} from "./leaderboard-book";

export class Leaderboard extends DurableObject<Env> {
  private readonly book = new LeaderboardBook();
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      const parse = (rows: Iterable<Record<string, SqlStorageValue>>) => [...rows].map((r) => JSON.parse(String(r.data)));
      this.book.load(
        parse(this.sql.exec(`SELECT data FROM players`)),
        parse(this.sql.exec(`SELECT data FROM matches ORDER BY ts DESC LIMIT ${MaxStoredMatches}`)),
        parse(this.sql.exec(`SELECT data FROM profiles`)),
      );
    });
  }

  private savePlayer(p: LeaderboardEntry): void {
    this.sql.exec(`INSERT OR REPLACE INTO players (id, data) VALUES (?, ?)`, p.playerId, JSON.stringify(p));
  }

  private saveMatch(m: MatchHistory): void {
    this.sql.exec(`INSERT OR REPLACE INTO matches (id, ts, data) VALUES (?, ?, ?)`, m.matchId, m.timestamp, JSON.stringify(m));
  }

  async recordRound(round: RoundResult): Promise<boolean> {
    const outcome = this.book.recordRound(round);
    if (!outcome) return false;
    this.saveMatch(outcome.match);
    for (const p of outcome.players) this.savePlayer(p);
    if (outcome.droppedMatchId) this.sql.exec(`DELETE FROM matches WHERE id = ?`, outcome.droppedMatchId);
    console.log(
      `[Leaderboard] Recorded ${round.mode} round (${outcome.match.matchId}) on ${outcome.match.levelName}: ` +
        outcome.match.players.map((p) => `${p.username} #${p.place} ${p.eloChange >= 0 ? "+" : ""}${p.eloChange}`).join(", "),
    );
    return true;
  }

  async upsertConnectedProfile(profile: ConnectedProfile): Promise<void> {
    const res = this.book.upsertConnectedProfile(profile);
    if (!res) return;
    if (res.player) this.savePlayer(res.player);
    this.sql.exec(`INSERT OR REPLACE INTO profiles (id, data) VALUES (?, ?)`, res.directory.playerId, JSON.stringify(res.directory));
  }

  async topPlayers(skip: number, take: number): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    return { entries: this.book.topPlayers(skip, take), total: this.book.players.size };
  }

  async recentMatches(playerId: string | null, skip: number, take: number): Promise<{ matches: MatchHistory[]; total: number }> {
    return { matches: this.book.recentMatches(playerId, skip, take), total: this.book.matches.length };
  }

  async users(skip: number, take: number): Promise<{ users: UserDirectoryEntry[]; total: number }> {
    return { users: this.book.allUsers(skip, take), total: this.book.totalKnownUsers() };
  }

  async user(playerId: string): Promise<UserDirectoryEntry | null> {
    return this.book.userById(playerId);
  }

  async counts(): Promise<{ players: number; matches: number }> {
    return { players: this.book.players.size, matches: this.book.matches.length };
  }

  /**
   * Imports the old server's data (global_leaderboard.json / match_history.json, or a MongoDB
   * export of the same documents). Existing players / matches with the same ids are replaced.
   */
  /** Adds players / matches (e.g. from the old server). replace = wipe everything first (players, matches, profiles). */
  async importData(players: unknown[], matches: unknown[], replace = false): Promise<{ players: number; matches: number }> {
    if (replace) {
      this.sql.exec(`DELETE FROM players`);
      this.sql.exec(`DELETE FROM matches`);
      this.sql.exec(`DELETE FROM profiles`);
      this.book.load([], [], []);
    }
    let pc = 0,
      mc = 0;
    for (const raw of players) {
      const e = toEntry(raw);
      if (!e) continue;
      this.book.players.set(e.playerId, e);
      this.savePlayer(e);
      pc++;
    }
    for (const raw of matches) {
      const m = toMatch(raw);
      if (!m) continue;
      this.saveMatch(m);
      mc++;
    }
    // Reload matches so ordering / the 1000 cap / duplicate ids stay consistent.
    const rows = [...this.sql.exec(`SELECT data FROM matches ORDER BY ts DESC`)].map((r) => JSON.parse(String(r.data)));
    for (const extra of rows.slice(MaxStoredMatches)) this.sql.exec(`DELETE FROM matches WHERE id = ?`, str(extra.matchId));
    this.book.load([...this.book.players.values()], rows.slice(0, MaxStoredMatches), [...this.book.profiles.values()]);
    return { players: pc, matches: mc };
  }
}
