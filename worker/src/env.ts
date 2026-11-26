import type { Hub } from "./hub";
import type { Leaderboard } from "./leaderboard";
import type { RegistryOptions } from "./registry";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  LEADERBOARD: DurableObjectNamespace<Leaderboard>;
  BUCKET: R2Bucket;
  MAX_UPLOAD_MB?: string;
  UPLOAD_CHUNK_MB?: string;
  MAX_ROOM_MEMBERS?: string;
  STALL_TIMEOUT_SECONDS?: string;
  DOWNLOAD_COMPLETION_GRACE_SECONDS?: string;
  LOADING_TIMEOUT_SECONDS?: string;
  CACHE_MINUTES?: string;
  PROGRESS_INTERVAL_MS?: string;
  TESTING_OPEN?: string;
  TESTING_MESSAGE?: string;
  HUB_LOCATION_HINT?: string;
  ADMIN_TOKEN?: string;
}

export const SERVER_VERSION = "1.0.0-workers";

const n = (v: string | undefined, fallback: number) => {
  const x = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(x) ? x : fallback;
};

export function registryOptions(env: Env): Partial<RegistryOptions> {
  return {
    maxUploadMegabytes: n(env.MAX_UPLOAD_MB, 250),
    uploadChunkMegabytes: n(env.UPLOAD_CHUNK_MB, 6),
    maxRoomMembers: n(env.MAX_ROOM_MEMBERS, 16),
    stallTimeoutSeconds: n(env.STALL_TIMEOUT_SECONDS, 300),
    downloadCompletionGraceSeconds: n(env.DOWNLOAD_COMPLETION_GRACE_SECONDS, 600),
    loadingTimeoutSeconds: n(env.LOADING_TIMEOUT_SECONDS, 180),
    cacheMinutes: n(env.CACHE_MINUTES, 15),
    progressIntervalMs: n(env.PROGRESS_INTERVAL_MS, 200),
    serverVersion: SERVER_VERSION,
  };
}

/** The single room server (all rooms live in one Durable Object, like the single RoomRegistry). */
export function hubStub(env: Env): DurableObjectStub<Hub> {
  const id = env.HUB.idFromName("main");
  const hint = (env.HUB_LOCATION_HINT ?? "").trim();
  return hint ? env.HUB.get(id, { locationHint: hint as DurableObjectLocationHint }) : env.HUB.get(id);
}

export function leaderboardStub(env: Env): DurableObjectStub<Leaderboard> {
  return env.LEADERBOARD.get(env.LEADERBOARD.idFromName("global"));
}
