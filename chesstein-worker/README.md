# Chesstein Worker

Cloudflare Worker backend for Chesstein multiplayer rooms.

The frontend can stay on GitHub Pages. This Worker only handles backend work:

- create public/private rooms
- list only waiting public rooms
- one WebSocket endpoint per room
- one Durable Object per game room
- a lobby Durable Object for public room listings
- waiting -> active -> finished/cancelled/abandoned room lifecycle
- creator is White, second player is Black
- relay/store FEN and move history
- draw offer / accept / decline
- resign / game-over broadcasts
- empty-room cleanup

It has basic turn ownership checks, but it does **not** fully validate chess moves yet. That should be a later pass with `chess.js` or explicit validation logic.

## Folder placement

Put this folder in the root of your GitHub Pages repo:

```text
jsippis.github.io/
  chesstein/          # frontend, still hosted by GitHub Pages
  chesstein-worker/   # backend, deployed by Cloudflare Workers
```

## Local setup

```powershell
cd chesstein-worker
npm install
npm run dev
```

Then test:

```powershell
curl http://127.0.0.1:8787/health
```

Create a room:

```powershell
curl -X POST http://127.0.0.1:8787/api/rooms `
  -H "Content-Type: application/json" `
  -d '{"visibility":"public","name":"Joonas"}'
```

List public waiting rooms:

```powershell
curl http://127.0.0.1:8787/api/rooms
```

Cancel a waiting room:

```powershell
curl -X DELETE "http://127.0.0.1:8787/api/rooms/ABC123?token=CREATOR_TOKEN"
```

## Deploy from terminal

```powershell
cd chesstein-worker
npm install
npx wrangler login
npm run deploy
```

After deployment, Cloudflare will give you a `workers.dev` URL. Put that URL into the Chesstein lobby's **Room server URL** field.

## Deploy from Cloudflare dashboard

In the Worker Git integration screen:

- Repository: `Jsippis/jsippis.github.io`
- Root directory: `chesstein-worker`
- Build command: leave empty, or use `npm install` if Cloudflare asks for one
- Deploy command: `npx wrangler deploy`

## API

### `GET /health`

Health check.

### `POST /api/rooms`

Create a room. The creator is assigned White and waits in the lobby until Black joins.

```json
{
  "visibility": "public",
  "name": "Joonas",
  "clientType": "gui"
}
```

Response includes:

```json
{
  "ok": true,
  "roomCode": "ABC123",
  "playerToken": "...",
  "color": "white",
  "wsUrl": "wss://.../ws/rooms/ABC123?token=...&client=gui"
}
```

### `GET /api/rooms`

List public rooms that are still waiting for an opponent.

### `GET /api/rooms/:roomCode`

Get a room snapshot.

### `DELETE /api/rooms/:roomCode?token=...`

Cancel a waiting room. Only the creator token can cancel the room.

### `GET /ws/rooms/:roomCode?token=...&client=gui&name=...`

WebSocket endpoint.

Client example:

```js
const ws = new WebSocket(
  "wss://your-worker.workers.dev/ws/rooms/ABC123?token=PLAYER_TOKEN&client=gui&name=Joonas"
);

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "request_sync" }));
};
```

Send a board update:

```js
ws.send(JSON.stringify({
  type: "move",
  uci: "e2e4",
  san: "e4",
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1",
  history: ["e4"]
}));
```

Draw / resign messages:

```js
ws.send(JSON.stringify({ type: "draw_offer" }));
ws.send(JSON.stringify({ type: "draw_accept" }));
ws.send(JSON.stringify({ type: "draw_decline" }));
ws.send(JSON.stringify({ type: "resign" }));
```

The room broadcasts `draw_offer`, `draw_declined`, `room_update`, and `game_over` messages back to connected clients.

## Frontend origin

`wrangler.jsonc` currently allows CORS from:

```text
https://jsippis.github.io
http://localhost:8000
http://127.0.0.1:8000
http://localhost:5500
http://127.0.0.1:5500
```

Add more origins in `ALLOWED_ORIGINS` if needed.

## Physical-board room events

Bridge clients can send `physical_lift` and `physical_place` messages while they are a seated physical-board player. The room broadcasts those events to all connected clients so companion browsers can highlight the legal moves that the physical LEDs are showing.

After a game is finished, seated players may use the existing `rematch_offer` / `rematch_accept` flow. The Python bridge maps the physical board reset button to those messages.

## Anonymous analysis calibration (D1)

The Chess.com analyzer can optionally upload anonymous summary measurements so Chesstein's deterministic accuracy formula can be calibrated against Chess.com's published game-level accuracy. It does **not** upload usernames, the PGN, or the Chess.com game URL. It sends a SHA-256 game hash, rating bucket, time class, versioned analysis features, and both final accuracy values.

The Worker endpoint is already implemented at:

```text
POST /api/calibration
```

The endpoint returns `503 calibration_not_configured` until a D1 binding named `CALIBRATION_DB` is added.

### One-time D1 setup

Create the database:

```powershell
cd chesstein-worker
npm install
npm run d1:create
```

Wrangler prints a `database_id`. Add this block to `wrangler.jsonc` after `vars` using that real ID:

```jsonc
"d1_databases": [
  {
    "binding": "CALIBRATION_DB",
    "database_name": "chesstein-calibration",
    "database_id": "PASTE_THE_ID_FROM_WRANGLER_HERE",
    "migrations_dir": "migrations"
  }
],
```

Apply the table migration locally for development:

```powershell
npm run d1:migrate:local
```

Apply all pending migrations to the production database:

```powershell
npm run d1:migrate:remote
```

The phase-aware analysis pass adds `0003_phase_aware_features.sql`. Wrangler applies only migrations that have not already run.

Then deploy the Worker:

```powershell
npm run deploy
```

Check aggregate calibration status:

```powershell
curl https://chesstein.jospire1.workers.dev/api/calibration/stats
```

Or query it through Wrangler:

```powershell
npm run d1:stats
```

The browser keeps only failed uploads in an IndexedDB retry queue. Successfully uploaded samples are stored permanently in D1 and removed from the local queue.

### Conversion-feature migration

The conversion-aware analysis adds calibration columns for exact-best moves,
slower/missed mates, settled winning/losing positions, and conversion loss.
After pulling this version, apply the new migration before deploying the Worker:

```powershell
cd chesstein-worker
npm.cmd run d1:migrate:remote
npm.cmd run deploy
```

Wrangler should apply `0002_conversion_features.sql`. Existing calibration rows
remain valid and keep zero defaults for the newly added fields; new rows are
separated by `feature_version` and `formula_version`.
