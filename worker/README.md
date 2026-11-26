# FunkyMaker online server — Cloudflare Workers

Port of the ASP.NET server (`../src`) to the Cloudflare free plan, so level transfers stop counting
against Render's 5 GB bandwidth limit. Workers and R2 don't charge for bandwidth.

| Piece | Old server (Render) | Here |
|---|---|---|
| Rooms, matches, chat | `RoomRegistry` + SignalR hub | `Hub` Durable Object (`src/registry.ts`, `src/hub.ts`), plain WebSocket |
| Level files | temp folder on disk | R2 `transfers/` (chunked upload = R2 multipart) |
| Official levels | `verified_levels/` folder | R2 `verified/` + `verified/index.json` |
| Leaderboard | JSON files / MongoDB | `Leaderboard` Durable Object (SQLite), persistent |
| Replays | memory | R2 `replays/` |

The HTTP API keeps the same routes and JSON (camelCase): `/health`, `/api/testing`,
`/api/server/info`, `/api/leaderboard`, `/api/users[/{id}]`, `/api/verified_levels[/{id}/download]`,
`/api/transfers/{id}/file|chunks|complete`, `/api/replays`.

## Commands

```sh
npm install
npm test               # unit tests (port of RoomFlowTests / ranking / ELO)
npm run typecheck
npm run dev            # local server on http://127.0.0.1:8787 (local DO + R2 simulation)
node scripts/e2e.mjs   # end-to-end check against the dev server (or pass a URL)
npm run sync-levels    # copy ../src/.../verified_levels into the local bucket
```

## Deploy (once)

1. `npx wrangler login`
2. Turn on R2 in the Cloudflare dashboard (it asks for a payment method even on the free plan),
   then `npx wrangler r2 bucket create funkymaker-online`.
3. Auto-delete leftovers (files of rooms that crashed, old replays, unfinished uploads):
   ```sh
   npx wrangler r2 bucket lifecycle add funkymaker-online transfers-1d transfers/ --expire-days 1 --abort-multipart-days 1
   npx wrangler r2 bucket lifecycle add funkymaker-online replays-1d replays/ --expire-days 1
   ```
   (The server already deletes each room's files when they expire or the room closes; this is
   the safety net.)
4. `npm run deploy` → prints the URL (`https://funkymaker-online.<account>.workers.dev`).
5. `npm run sync-levels -- --remote` (again whenever the official levels change).
6. Optional, to bring the old leaderboard over: `npx wrangler secret put ADMIN_TOKEN`, then
   ```sh
   curl -X POST https://…/api/admin/import -H "Authorization: Bearer <token>" \
        -H "Content-Type: application/json" \
        -d '{"players": <global_leaderboard.json>, "matches": <match_history.json>, "replace": false}'
   ```
   `"replace": true` wipes the leaderboard, match history and user directory first (e.g. to remove test data).

Settings live in `wrangler.toml` `[vars]` (same knobs as the `Transfer__*` / `Testing__*` env vars).
`HUB_LOCATION_HINT` chooses the region of the room server the first time it's created (e.g. `sam`
for South America, `weur` for Europe); empty = near the first player who connects.

## Free plan limits (and why it fits)

- **Workers**: 100,000 requests/day, 10 ms CPU per request. File bytes are piped between the client
  and R2 without JavaScript touching them, so a transfer costs ~no CPU. Each chunk = 2–3 requests.
- **Durable Objects**: 100,000 requests/day; every 20 incoming WebSocket messages count as one. A
  4-player, 10-song session is ~10,000. Duration: 13,000 GB-s/day ≈ 28 h of the hub being awake;
  it's only awake while somebody is connected.
- **R2**: 10 GB stored, 1 M writes, 10 M reads per month, **free egress**. Files live minutes.
  Going over the free tier is billed (no hard cap): set a billing notification in the dashboard.

## Client changes (protocol 4)

The server refuses protocol 3 clients with the usual "Update the game" message.

1. **WebSocket instead of SignalR**: connect to `wss://<host>/multiplayer`. Every frame is JSON text:
   - client → server: `{"type":"invoke","id":7,"method":"JoinRoom","args":[{...}]}`.
     `id` is optional: no `id` = fire and forget (use it for `SendState` / `SendHit` /
     `SendKeyPress` / `Ping` / `SetLevelStatus`…, like `SendAsync`).
   - server → client: `{"type":"result","id":7,"result":…}` or `{"type":"result","id":7,"error":"…"}`
     for invocations, and `{"type":"event","method":"RoomState","payload":{…}}` for what used to be
     `hub.On<T>(method)`. Method names, arguments and payloads are unchanged (camelCase JSON;
     the server accepts any casing).
   - `{"type":"ping"}` every 10 s from the server (ignore it). The client must send something at least
     every 90 s — the existing `Ping` invocation is enough (or `{"type":"keepalive"}`).
   - Messages over ~384 KB (big level lists, RoomState with many levels) come as
     `{"type":"frag","fid":"…","i":0,"n":3,"data":"…"}`: concatenate `data` for `i = 0..n-1`, then parse.
     The client should split its own big messages (`CreateRoom` / `JoinRoom` / `UpdateLevels` with
     thousands of osu! difficulties) the same way, at ≤ 256 KB per fragment.
   - Reconnect = open a new socket and send `Hello` again (no SignalR automatic reconnect).
2. **Chunked uploads**: use `HelloResult.uploadChunkBytes` (6 MiB) for every chunk except the last —
   R2 multipart parts must all be the same size, so offsets must be multiples of it.
3. **Packed uploads** (osu! `.osz`, FNF `chartonly`): send `X-File-Hash: <sha256 hex>` on
   `POST /complete` (chunked) or on `PUT /file`. The client already computes it for downloaders.
4. **Single PUT** is limited to 100 MB by Workers; always prefer chunked uploads.
5. Download progress: keep sending `SetLevelStatus(downloading, progress)` (the client already
   does, every 5 %). The server no longer counts bytes itself; these reports keep the download alive.
