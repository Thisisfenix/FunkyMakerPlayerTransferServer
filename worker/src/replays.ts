// Port of ReplayExchange.cs: after a match each player uploads their own recording (a small gzip
// JSON "track"), keyed by (uploader, opponent, level hash); the opponent downloads it.
//   PUT /api/replays?player=A&opponent=B&level=H   body: A's track
//   GET /api/replays?player=A&opponent=B&level=H   A's latest track vs B on H, or 404
// Stored in R2 under replays/ (the bucket's lifecycle rule deletes them after a day; reads older
// than TTL_MS are treated as missing, like the old in-memory 30 minute expiry).

import type { Env } from "./env";

export const TTL_MS = 30 * 60_000;
export const MaxTrackBytes = 4 * 1024 * 1024;

const IdRe = /^[A-Za-z0-9-]{1,64}$/;
const HashRe = /^[0-9a-f]{64}$/;

export function replayKey(player: string | null, opponent: string | null, level: string | null): string | null {
  const lvl = level?.trim().toLowerCase() ?? null;
  if (player === null || opponent === null || lvl === null) return null;
  if (!IdRe.test(player) || !IdRe.test(opponent) || !HashRe.test(lvl)) return null;
  return `replays/${player}/${opponent}/${lvl}.gz`;
}

const bad = () => new Response("Invalid player, opponent or level.", { status: 400 });

export async function putReplay(url: URL, request: Request, env: Env): Promise<Response> {
  const key = replayKey(url.searchParams.get("player"), url.searchParams.get("opponent"), url.searchParams.get("level"));
  if (!key) return bad();
  const announced = Number(request.headers.get("Content-Length") ?? "0");
  if (announced > MaxTrackBytes) return new Response(null, { status: 413 });
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MaxTrackBytes) return new Response(null, { status: 413 });
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) return new Response("Expected a gzip replay track.", { status: 400 });
  await env.BUCKET.put(key, data, { httpMetadata: { contentType: "application/gzip" } });
  return new Response(null, { status: 200 });
}

export async function getReplay(url: URL, env: Env): Promise<Response> {
  const key = replayKey(url.searchParams.get("player"), url.searchParams.get("opponent"), url.searchParams.get("level"));
  if (!key) return bad();
  const obj = await env.BUCKET.get(key);
  if (!obj || Date.now() - obj.uploaded.getTime() > TTL_MS) return new Response(null, { status: 404 });
  return new Response(obj.body, { headers: { "Content-Type": "application/gzip" } });
}
