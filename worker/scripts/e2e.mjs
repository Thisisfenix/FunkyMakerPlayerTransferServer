// End-to-end check against a running server (npx wrangler dev, or the deployed URL):
//   node scripts/e2e.mjs [http://127.0.0.1:8787]
// Two fake players connect over WebSocket, create / join a room, send a ~7 MB level through the
// chunked R2 upload (2 multipart parts), download it, play a round and read the leaderboard.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws") + "/multiplayer";
const PROTOCOL = 4;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures++;
};

class Player {
  constructor(name) {
    this.name = name;
    this.playerId = randomUUID();
    this.events = [];
    this.pending = new Map();
    this.frags = new Map();
    this.nextId = 1;
  }
  async connect() {
    this.ws = new WebSocket(WS);
    this.ws.addEventListener("message", (ev) => this.onMessage(JSON.parse(ev.data)));
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
    });
  }
  onMessage(msg) {
    if (msg.type === "frag") {
      const e = this.frags.get(msg.fid) ?? [];
      e[msg.i] = msg.data;
      this.frags.set(msg.fid, e);
      if (e.filter((x) => x !== undefined).length === msg.n) {
        this.frags.delete(msg.fid);
        this.onMessage(JSON.parse(e.join("")));
      }
      return;
    }
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error));
      else p?.resolve(msg.result);
    } else if (msg.type === "event") this.events.push(msg);
  }
  invoke(method, ...args) {
    const id = this.nextId++;
    const text = JSON.stringify({ type: "invoke", id, method, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: ${method} got no reply`)), 10_000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.sendText(text);
    });
  }
  send(method, ...args) {
    this.sendText(JSON.stringify({ type: "invoke", method, args }));
  }
  sendText(text) {
    const max = 256 * 1024;
    if (text.length <= max) return this.ws.send(text);
    const fid = randomUUID().slice(0, 8);
    const n = Math.ceil(text.length / max);
    for (let i = 0; i < n; i++) this.ws.send(JSON.stringify({ type: "frag", fid, i, n, data: text.slice(i * max, (i + 1) * max) }));
  }
  async waitFor(method, pred = () => true, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = [...this.events].reverse().find((e) => e.method === method && pred(e.payload));
      if (hit) return hit.payload;
      await sleep(25);
    }
    throw new Error(`${this.name}: no ${method} in ${timeout} ms`);
  }
  close() {
    this.ws.close();
  }
}

function level(name, size) {
  const bytes = randomBytes(size);
  bytes[0] = 0x50;
  bytes[1] = 0x4b;
  bytes[2] = 3;
  bytes[3] = 4;
  return { bytes, hash: sha(bytes), entry: { Hash: sha(bytes), Name: name, FileName: name + ".fnmm", Size: size, Stars: 3 } };
}

async function main() {
  const health = await (await fetch(`${BASE}/health`)).json();
  check(health.protocol === PROTOCOL, `health reports protocol ${PROTOCOL}`);
  check((await (await fetch(`${BASE}/api/testing`)).json()).open === true, "testing gate open");

  const lvl = level("BigLevel", 7 * 1024 * 1024 + 4321);
  const a = new Player("A");
  const b = new Player("B");
  await a.connect();
  await b.connect();

  const bad = await b.invoke("Hello", { ProtocolVersion: 3, Username: "Old" });
  check(!bad.ok && bad.error.includes("Update the game"), "old protocol refused");

  const helloA = await a.invoke("Hello", { PlayerId: a.playerId, Username: "A", ColorHue: 100, ProtocolVersion: PROTOCOL });
  const helloB = await b.invoke("Hello", { playerId: b.playerId, username: "B", colorHue: 200, protocolVersion: PROTOCOL });
  check(helloA.ok && helloB.ok, "hello (PascalCase and camelCase)");
  check(helloA.supportsChunkedUpload && helloA.uploadChunkBytes >= 5 * 1024 * 1024, `chunk size ${helloA.uploadChunkBytes}`);

  // Big level list (forces fragmented messages both ways).
  const filler = Array.from({ length: 4000 }, (_, i) => {
    const h = sha(Buffer.from("filler" + i + a.playerId));
    return { Hash: h, Name: "Filler " + i, FileName: `Filler ${i}.fnmm`, Size: 1000 + i, Stars: 1 };
  });
  const small = level("SmallLevel", 300_000);
  const created = await a.invoke("CreateRoom", { Name: "E2E", Settings: { Mode: "versus", MaxPlayers: 4 }, Levels: [lvl.entry, small.entry, ...filler] });
  check(created.ok, `room created ${created.roomId}`);
  const rooms = await b.invoke("ListRooms");
  check(rooms.some((r) => r.id === created.roomId), "room listed");
  check((await b.invoke("JoinRoom", { RoomId: created.roomId, Levels: [] })).ok, "B joined");
  const state = await b.waitFor("RoomState", (s) => s.levels && s.levels.length === 4002);
  check(state.members.length === 2, "B got the 4002-level list (fragmented RoomState)");

  check((await a.invoke("SelectSong", { Source: "local", Hash: lvl.hash, Stars: 4.5 })).ok, "A picked the level");
  const up = await a.waitFor("TransferUpload");
  check(up.size === lvl.bytes.length, "upload ticket has the exact size");

  // Chunked upload, with a retry of chunk 0.
  const chunk = helloA.uploadChunkBytes;
  for (let off = 0; off < lvl.bytes.length; off += chunk) {
    const body = lvl.bytes.subarray(off, Math.min(off + chunk, lvl.bytes.length));
    for (let attempt = 0; attempt < (off === 0 ? 2 : 1); attempt++) {
      const r = await fetch(`${BASE}/api/transfers/${up.transferId}/chunks?offset=${off}`, {
        method: "PUT",
        headers: { "X-Transfer-Token": up.token },
        body,
      });
      check(r.ok, `chunk @${off} (attempt ${attempt + 1}) → ${r.status}`);
    }
  }
  const done = await fetch(`${BASE}/api/transfers/${up.transferId}/complete`, { method: "POST", headers: { "X-Transfer-Token": up.token } });
  check(done.ok, `complete → ${done.status} ${done.ok ? "" : await done.text()}`);

  const down = await b.waitFor("TransferDownload");
  const got = Buffer.from(await (await fetch(`${BASE}/api/transfers/${down.transferId}/file`, { headers: { "X-Transfer-Token": down.token } })).arrayBuffer());
  check(sha(got) === lvl.hash && got.length === lvl.bytes.length, `downloaded ${got.length} bytes, hash matches`);
  const badDown = await fetch(`${BASE}/api/transfers/${down.transferId}/file`, { headers: { "X-Transfer-Token": "nope" } });
  check(badDown.status === 409, "wrong token refused");
  b.send("SetLevelStatus", { Hash: lvl.hash, State: "downloading", Progress: 1 });
  b.send("CompleteDownload", down.transferId, true, null);
  await b.waitFor("RoomState", (s) => s.members.every((m) => m.levelStatus === "ready"));
  check((await b.invoke("SetReady", true)).ok, "B ready");

  const info = await a.waitFor("MatchLoading");
  a.send("MatchLoaded", info.matchId);
  b.send("MatchLoaded", info.matchId);
  const start = await a.waitFor("MatchStart");
  check(start.startTimestamp > Date.now(), "synced start time in the future");
  a.send("SendHit", { Lane: 2, Rating: "sick", SongTime: 1.5 });
  const hit = await b.waitFor("PlayerHit");
  check(hit.playerId === a.playerId && hit.lane === 2, "hit relayed with the sender id");
  a.send("FinishMatch", { MatchId: info.matchId, Score: 5000, Accuracy: 95, Sicks: 50 });
  b.send("FinishMatch", { MatchId: info.matchId, Score: 7000, Accuracy: 98, Sicks: 60 });
  const result = await a.waitFor("MatchResults");
  check(result.players[0].username === "B" && result.players[0].place === 1, "B wins");

  // Round 2: B's turn, picks A's small level → single PUT upload (R2 checks the SHA-256).
  await b.waitFor("RoomState", (s) => s.phase === "lobby" && s.turnPlayerId === b.playerId);
  check((await b.invoke("SelectSong", { Source: "local", Hash: small.hash })).ok, "B picked A's small level");
  const up2 = await a.waitFor("TransferUpload", (u) => u.hash === small.hash);
  const tampered = Buffer.from(small.bytes);
  tampered[100] ^= 0xff;
  const badPut = await fetch(`${BASE}/api/transfers/${up2.transferId}/file`, { method: "PUT", headers: { "X-Transfer-Token": up2.token }, body: tampered });
  check(badPut.status === 400, `tampered single PUT rejected by R2's checksum (${badPut.status})`);
  const failed = await b.waitFor("TransferFailed", (f) => f.hash === small.hash);
  check(failed.reason.includes("did not match"), `B told: ${failed.reason}`);
  // "missing" = please send it again → A is asked to upload once more; this time the real bytes.
  b.send("SetLevelStatus", { Hash: small.hash, State: "missing", Progress: 0 });
  const up3 = await a.waitFor("TransferUpload", (u) => u.hash === small.hash && u.transferId !== up2.transferId);
  const goodPut = await fetch(`${BASE}/api/transfers/${up3.transferId}/file`, { method: "PUT", headers: { "X-Transfer-Token": up3.token }, body: small.bytes });
  check(goodPut.ok, `single PUT upload → ${goodPut.status}`);
  const down2 = await b.waitFor("TransferDownload", (d) => d.hash === small.hash);
  const got2 = Buffer.from(await (await fetch(`${BASE}/api/transfers/${down2.transferId}/file`, { headers: { "X-Transfer-Token": down2.token } })).arrayBuffer());
  check(sha(got2) === small.hash, "single-PUT level downloaded intact");

  await sleep(500);
  const lb = await (await fetch(`${BASE}/api/leaderboard`)).json();
  check(JSON.stringify(lb).includes(result.matchId), "round recorded in the leaderboard");
  a.invoke("GetLeaderboard", { Take: 5 });
  const lbr = await a.waitFor("LeaderboardResponse");
  check(lbr.entries.length >= 2, "leaderboard over WebSocket");

  // Replays
  const gz = Buffer.from([0x1f, 0x8b, 1, 2, 3]);
  const q = `player=${a.playerId}&opponent=${b.playerId}&level=${lvl.hash}`;
  check((await fetch(`${BASE}/api/replays?${q}`, { method: "PUT", body: gz })).ok, "replay uploaded");
  const rp = Buffer.from(await (await fetch(`${BASE}/api/replays?${q}`)).arrayBuffer());
  check(rp.equals(gz), "replay downloaded");

  a.close();
  b.close();
  await sleep(500);
  const after = await (await fetch(`${BASE}/health`)).json();
  check(after.stats.rooms === 0, `rooms cleaned up after disconnect (${after.stats.rooms})`);

  console.log(failures === 0 ? "\nALL GOOD" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
