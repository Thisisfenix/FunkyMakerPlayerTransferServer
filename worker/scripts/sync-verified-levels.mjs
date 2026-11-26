// Uploads the official levels to R2 with their precomputed SHA-256 (the Worker can't hash big files).
//   npm run sync-levels              → local dev bucket (wrangler dev)
//   npm run sync-levels -- --remote  → the real bucket on Cloudflare
// Reads ../src/FunkyMakerTransferServer/verified_levels/*.fnmm (any case), writes verified/<file>
// for each level and verified/index.json (the list GET /api/verified_levels returns).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..");
const folder = resolve(worker, "../src/FunkyMakerTransferServer/verified_levels");
const bucket = "funkymaker-online";
const remote = process.argv.includes("--remote");
const wranglerBin = join(worker, "node_modules", "wrangler", "bin", "wrangler.js");

function put(key, file, contentType) {
  const args = [wranglerBin, "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", contentType, remote ? "--remote" : "--local"];
  const r = spawnSync(process.execPath, args, { cwd: worker, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`Uploading ${key} failed`);
}

const files = readdirSync(folder).filter((f) => extname(f).toLowerCase() === ".fnmm");
if (files.length === 0) console.log(`No .fnmm files in ${folder}`);

const levels = files.map((f) => {
  const path = join(folder, f);
  const name = basename(f, extname(f));
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    id: name.toLowerCase().replaceAll(" ", "_"),
    name,
    hash,
    fileSize: statSync(path).size,
    filename: f,
    difficulty: "Medium",
    description: `Official level: ${name}`,
    path,
  };
});

for (const l of levels) {
  console.log(`→ ${l.filename} (${l.hash.slice(0, 8)}…, ${l.fileSize} bytes)`);
  put(`verified/${l.filename}`, l.path, "application/octet-stream");
}

const index = join(mkdtempSync(join(tmpdir(), "fm-levels-")), "index.json");
writeFileSync(index, JSON.stringify(levels.map(({ path, ...rest }) => rest), null, 2));
put("verified/index.json", index, "application/json");
console.log(`\n${levels.length} official level(s) synced to ${remote ? "the remote" : "the local"} bucket.`);
