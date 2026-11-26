// HTTP side of level transfers (port of TransferEndpoints.cs), files stored in R2:
//   PUT  /api/transfers/{id}/file              whole file (<= 100 MB: the Workers request body limit)
//   PUT  /api/transfers/{id}/chunks?offset=N   one chunk = one R2 multipart part (offset % chunk == 0)
//   POST /api/transfers/{id}/complete          finish a chunked upload
//   GET  /api/transfers/{id}/file              download (streamed from R2 untouched)
// Headers: X-Transfer-Token (all); X-File-Hash = SHA-256 of the uploaded file, required for packed
// variants (osu! .osz, FNF chartonly) because the Worker can't hash big files within its CPU limit.
// Bytes pass through without JavaScript touching them, so a transfer costs almost no CPU time.

import { type Env, hubStub } from "./env";
import { Protocol } from "./protocol";

const HashRe = /^[0-9a-f]{64}$/;
const MaxSingleChunkBytes = 20 * 1024 * 1024;

export function problem(detail: string, status: number): Response {
  return Response.json({ title: statusTitle(status), status, detail }, { status, headers: { "Content-Type": "application/problem+json" } });
}

function statusTitle(status: number): string {
  return (
    { 400: "Bad Request", 404: "Not Found", 409: "Conflict", 410: "Gone", 411: "Length Required", 413: "Payload Too Large", 500: "Internal Server Error" }[status] ??
    "Error"
  );
}

/** ZIP ("PK") or RAR ("Rar!") signature — the formats the game can load. */
export function hasKnownSignature(h: Uint8Array): boolean {
  return h.length >= 4 && ((h[0] === 0x50 && h[1] === 0x4b) || (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21));
}

const NotArchive = "The file is not a level archive (.fnmm/.zip/.rar/.osz).";

function token(request: Request): string {
  return request.headers.get(Protocol.TokenHeader) ?? "";
}

function contentLength(request: Request): number | null {
  const v = request.headers.get("Content-Length");
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function reportedHash(request: Request): string | null {
  const h = (request.headers.get(Protocol.FileHashHeader) ?? "").trim().toLowerCase();
  return h.length === 0 ? null : h;
}

// ── PUT /api/transfers/{id}/file ────────────────────────────────────────────

export async function upload(id: string, request: Request, env: Env): Promise<Response> {
  const hub = hubStub(env);
  const begin = await hub.beginUpload(id, token(request));
  if (!begin.ok) return problem(begin.error, 409);
  const t = begin.ticket;
  const fail = async (reason: string, status = 400, detail = reason) => {
    await hub.failUpload(id, reason, t.key);
    return problem(detail, status);
  };

  const len = contentLength(request);
  if (len === null || !request.body) return fail("The upload has no Content-Length.", 411);
  if (t.exactSize ? len !== t.size : len > t.size)
    return fail(
      t.exactSize ? "The upload size does not match the level." : "The packed set is larger than this server allows.",
      400,
      "Content-Length does not match the level size.",
    );
  if (len < 4) return fail("The file is too small to be a level.");

  const claimed = reportedHash(request);
  let sha256: string;
  if (t.exactSize) {
    if (claimed !== null && claimed !== t.hash)
      return fail("The uploaded file did not match the level (it may have changed on disk).");
    sha256 = t.hash;
  } else {
    if (claimed === null || !HashRe.test(claimed)) return fail(`Packed uploads need the ${Protocol.FileHashHeader} header.`);
    sha256 = claimed;
  }

  try {
    // R2 checks the SHA-256 itself and rejects the object when it doesn't match.
    await env.BUCKET.put(t.key, request.body, { sha256, httpMetadata: { contentType: "application/octet-stream" } });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/sha|digest|checksum|hash/i.test(msg))
      return fail(
        t.exactSize
          ? "The uploaded file did not match the level (it may have changed on disk)."
          : `The upload does not match its ${Protocol.FileHashHeader}.`,
      );
    console.log(`[Upload] ${id} failed: ${msg}`);
    return fail("The upload was interrupted.", 400, "Upload failed.");
  }

  const head = await env.BUCKET.get(t.key, { range: { offset: 0, length: 4 } });
  const sig = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array();
  if (!hasKnownSignature(sig)) return fail(NotArchive);

  const done = await hub.completeUpload(id, t.key, sha256, len);
  return done.ok ? new Response(null, { status: 200 }) : problem(done.error, 400);
}

// ── PUT /api/transfers/{id}/chunks?offset=N ─────────────────────────────────

export async function uploadChunk(id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const offsetText = url.searchParams.get("offset") ?? "";
  const offset = Number(offsetText);
  if (offsetText === "" || !Number.isInteger(offset) || offset < 0)
    return problem("Missing or invalid offset query parameter.", 400);
  const len = contentLength(request);
  if (len === null) return problem("The chunk has no Content-Length.", 411);
  if (len > MaxSingleChunkBytes) return problem("Chunk is too large.", 413);

  const hub = hubStub(env);
  const begin = await hub.beginChunkUpload(id, token(request), offset, len);
  if (!begin.ok) return problem(begin.error, 409);
  const t = begin.ticket;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    await hub.abortChunkWrite(id);
    return new Response(null, { status: 499 });
  }
  if (bytes.length !== len) {
    await hub.abortChunkWrite(id);
    return problem("Chunk body ended early; retry this offset.", 400);
  }
  if (offset === 0 && (bytes.length < 4 || !hasKnownSignature(bytes))) {
    const reason = bytes.length < 4 ? "The file is too small to be a level." : NotArchive;
    await hub.failUpload(id, reason, null);
    return problem(reason, 400);
  }

  try {
    const part = await env.BUCKET.resumeMultipartUpload(t.key, t.uploadId!).uploadPart(t.partNumber, bytes);
    await hub.finishChunkUpload(id, t.partNumber, part.etag, bytes.length);
  } catch (e) {
    console.log(`[UploadChunk] ${id} part ${t.partNumber} failed: ${e}`);
    await hub.abortChunkWrite(id);
    return problem("Chunk upload failed; retry this offset.", 500);
  }
  return Response.json({ written: offset + bytes.length });
}

// ── POST /api/transfers/{id}/complete ───────────────────────────────────────

export async function completeChunked(id: string, request: Request, env: Env): Promise<Response> {
  const hub = hubStub(env);
  const begin = await hub.beginCompleteChunkedUpload(id, token(request));
  if (!begin.ok) return problem(begin.error, 409);
  const t = begin.ticket;
  const fail = async (reason: string) => {
    await hub.failUpload(id, reason, null);
    return problem(reason, 400);
  };

  if (t.exactSize && t.totalBytes < t.maxSize) return fail("The upload ended early (connection closed before finishing).");
  if (t.totalBytes > t.maxSize) return fail("The upload is larger than the level.");

  const claimed = reportedHash(request);
  let hash: string;
  if (t.exactSize) {
    if (claimed !== null && claimed !== t.expectedHash)
      return fail("The uploaded file did not match the level (it may have changed on disk).");
    hash = t.expectedHash; // downloaders verify it
  } else {
    if (claimed === null || !HashRe.test(claimed)) return fail(`Packed uploads need the ${Protocol.FileHashHeader} header.`);
    hash = claimed;
  }

  try {
    await env.BUCKET.resumeMultipartUpload(t.key, t.uploadId).complete(t.parts);
  } catch (e) {
    console.log(`[CompleteChunkedUpload] ${id} failed: ${e}`);
    await hub.abortChunkWrite(id);
    return problem("Failed to finalize upload.", 500);
  }

  const done = await hub.completeUpload(id, t.key, hash, t.totalBytes);
  return done.ok ? new Response(null, { status: 200 }) : problem(done.error, 400);
}

// ── GET /api/transfers/{id}/file ────────────────────────────────────────────

export async function download(id: string, request: Request, env: Env): Promise<Response> {
  const hub = hubStub(env);
  const begin = await hub.beginDownload(id, token(request));
  if (!begin.ok) return new Response(begin.error, { status: 409 });
  const t = begin.ticket;
  const obj = await env.BUCKET.get(t.key);
  if (!obj) return new Response("The level file is gone.", { status: 410 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "no-store",
    },
  });
}
