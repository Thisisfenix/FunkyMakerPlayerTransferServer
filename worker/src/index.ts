// FunkyMaker online server on Cloudflare Workers: the Worker routes HTTP requests; rooms and matches
// live in the Hub Durable Object (WebSocket /multiplayer), the leaderboard in the Leaderboard
// Durable Object (SQLite), level files and replays in R2.

import { type Env, SERVER_VERSION, hubStub, leaderboardStub } from "./env";
import { loadOfficialLevels, objectKeyFor } from "./official";
import { Protocol } from "./protocol";
import { getReplay, putReplay } from "./replays";
import { completeChunked, download, problem, upload, uploadChunk } from "./transfers";

export { Hub } from "./hub";
export { Leaderboard } from "./leaderboard";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

const DATABASE = { provider: "DurableObjectSQLite", mongoDbEnabled: false, databaseName: null };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    let response: Response;
    try {
      response = await route(request, env);
    } catch (e) {
      console.log(`[Worker] ${request.method} ${new URL(request.url).pathname} failed: ${(e as Error).stack ?? e}`);
      response = problem("Server error.", 500);
    }
    if (response.status === 101) return response; // WebSocket upgrade: headers are immutable
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const seg = path.split("/").filter(Boolean);

  if (path === "/multiplayer") return hubStub(env).fetch(request);

  if (method === "GET" && path === "/") return Response.redirect(new URL("/api/server/info", url).toString(), 302);

  if (method === "GET" && path === "/health") {
    const hub = await hubStub(env).stats();
    return Response.json({ status: "ok", version: SERVER_VERSION, protocol: Protocol.Version, maxUploadBytes: hub.maxUploadBytes, stats: hub.stats });
  }

  if (method === "GET" && path === "/api/testing") {
    const open = (env.TESTING_OPEN ?? "true").trim().toLowerCase() === "true";
    return Response.json({ open, message: env.TESTING_MESSAGE ?? "" }, { headers: { "Cache-Control": "no-store" } });
  }

  // ── Transfers ──
  if (seg[0] === "api" && seg[1] === "transfers" && seg.length === 4) {
    const id = decodeURIComponent(seg[2]);
    const action = seg[3];
    if (action === "file" && method === "PUT") return upload(id, request, env);
    if (action === "file" && method === "GET") return download(id, request, env);
    if (action === "chunks" && method === "PUT") return uploadChunk(id, request, env, url);
    if (action === "complete" && method === "POST") return completeChunked(id, request, env);
  }

  // ── Replays ──
  if (path === "/api/replays") {
    if (method === "PUT") return putReplay(url, request, env);
    if (method === "GET") return getReplay(url, env);
  }

  // ── Official levels ──
  if (method === "GET" && path === "/api/verified_levels") {
    const levels = await loadOfficialLevels(env.BUCKET);
    return Response.json({ levels, timestamp: Date.now() });
  }
  if (method === "GET" && seg[0] === "api" && seg[1] === "verified_levels" && seg[3] === "download" && seg.length === 4) {
    return downloadOfficial(decodeURIComponent(seg[2]).toLowerCase(), request, env);
  }

  // ── Leaderboard / users ──
  if (method === "GET" && path === "/api/leaderboard") {
    const q = url.searchParams;
    const lb = leaderboardStub(env);
    const top = await lb.topPlayers(Math.max(0, intParam(q, "skip", 0)), clampInt(intParam(q, "take", 50), 1, 100));
    const recent = await lb.recentMatches(
      q.get("playerId") || null,
      Math.max(0, intParam(q, "matchesSkip", 0)),
      clampInt(intParam(q, "matchesTake", 50), 1, 100),
    );
    return Response.json({
      entries: top.entries,
      totalPlayers: top.total,
      matches: recent.matches,
      totalMatches: recent.total,
      database: DATABASE,
      timestamp: Date.now(),
    });
  }
  if (method === "GET" && path === "/api/users") {
    const q = url.searchParams;
    const page = await leaderboardStub(env).users(intParam(q, "skip", 0), intParam(q, "take", 200));
    return Response.json({ users: page.users, totalUsers: page.total, database: DATABASE, timestamp: Date.now() });
  }
  if (method === "GET" && seg[0] === "api" && seg[1] === "users" && seg.length === 3) {
    const playerId = decodeURIComponent(seg[2]).trim();
    if (!playerId) return Response.json({ error: "PlayerId is required" }, { status: 400 });
    const user = await leaderboardStub(env).user(playerId);
    if (!user) return Response.json({ error: `User '${playerId}' not found` }, { status: 404 });
    return Response.json({ user, timestamp: Date.now() });
  }

  // ── Server info ──
  if (method === "GET" && path === "/api/server/info") {
    const levels = await loadOfficialLevels(env.BUCKET);
    const counts = await leaderboardStub(env).counts();
    return Response.json({
      version: SERVER_VERSION,
      status: "Online",
      timestamp: Date.now(),
      architecture: { type: "CloudflareWorkers", features: ["Durable Objects", "R2 storage", "WebSocket hub"] },
      levels: { count: levels.length, names: levels.map((l) => l.name), totalSize: levels.reduce((s, l) => s + l.fileSize, 0) },
      database: { ...DATABASE, players: counts.players, matches: counts.matches, lastError: null },
      endpoints: [
        "GET /api/server/info",
        "GET /api/leaderboard",
        "GET /api/users",
        "GET /api/users/{playerId}",
        "GET /api/verified_levels",
        "GET /api/verified_levels/{id}/download",
        "WS /multiplayer (JSON envelope, protocol 4)",
      ],
    });
  }
  if (method === "GET" && path === "/api/server/health")
    return Response.json({ status: "Healthy", version: SERVER_VERSION, timestamp: Date.now() });

  // ── Admin: import the old leaderboard ──
  if (method === "POST" && path === "/api/admin/import") {
    if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`)
      return new Response("Unauthorized", { status: 401 });
    const body = (await request.json()) as {
      players?: unknown[];
      matches?: unknown[];
      Players?: unknown[];
      Matches?: unknown[];
      replace?: boolean;
    };
    const players = body.players ?? body.Players ?? [];
    const matches = body.matches ?? body.Matches ?? [];
    const res = await leaderboardStub(env).importData(Array.isArray(players) ? players : [], Array.isArray(matches) ? matches : [], body.replace === true);
    return Response.json({ imported: res });
  }

  return problem("Not found.", 404);
}

async function downloadOfficial(id: string, request: Request, env: Env): Promise<Response> {
  const levels = await loadOfficialLevels(env.BUCKET);
  const level = levels.find((l) => l.id.toLowerCase() === id);
  if (!level) return Response.json({ error: `Level '${id}' not found in verified_levels/` }, { status: 404 });
  const obj = await env.BUCKET.get(objectKeyFor(level), { range: request.headers, onlyIf: request.headers });
  if (!obj) return Response.json({ error: `Level '${id}' not found in verified_levels/` }, { status: 404 });
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${level.filename.replace(/"/g, "")}"`,
    "Accept-Ranges": "bytes",
    ETag: obj.httpEtag,
  });
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has("Range")) {
    const offset = range.suffix !== undefined ? obj.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? obj.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

function intParam(q: URLSearchParams, name: string, fallback: number): number {
  const v = q.get(name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
