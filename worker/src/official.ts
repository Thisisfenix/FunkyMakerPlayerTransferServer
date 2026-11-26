// Official (verified) levels. The Worker can't hash big files, so the list is precomputed by
// scripts/sync-verified-levels.mjs and stored in R2 next to the files:
//   verified/index.json   [{ id, name, hash, filename, fileSize, difficulty, description }]
//   verified/<filename>   the level file
import type { OfficialLevel } from "./registry";

export interface OfficialLevelInfo {
  id: string;
  name: string;
  hash: string;
  fileSize: number;
  filename: string;
  difficulty: string;
  description: string;
}

export const INDEX_KEY = "verified/index.json";
const CACHE_MS = 60_000;

let cached: { at: number; levels: OfficialLevelInfo[] } | null = null;

export async function loadOfficialLevels(bucket: R2Bucket, force = false): Promise<OfficialLevelInfo[]> {
  const now = Date.now();
  // An empty list (index not uploaded yet) is retried soon.
  if (!force && cached && now - cached.at < (cached.levels.length > 0 ? CACHE_MS : 5_000)) return cached.levels;
  try {
    const obj = await bucket.get(INDEX_KEY);
    const levels = obj ? ((await obj.json()) as OfficialLevelInfo[]) : [];
    cached = { at: now, levels: Array.isArray(levels) ? levels : [] };
  } catch (e) {
    console.log(`[Official] Could not read ${INDEX_KEY}: ${(e as Error).message}`);
    cached = { at: now, levels: cached?.levels ?? [] };
  }
  return cached.levels;
}

export function cachedOfficialLevels(): OfficialLevelInfo[] {
  return cached?.levels ?? [];
}

export function findOfficialByHash(hash: string): OfficialLevel | null {
  const info = cachedOfficialLevels().find((l) => l.hash.toLowerCase() === hash.toLowerCase());
  return info ? { id: info.id, name: info.name, fileName: info.filename, hash: info.hash.toLowerCase(), size: info.fileSize } : null;
}

export function objectKeyFor(level: OfficialLevelInfo): string {
  return `verified/${level.filename}`;
}
