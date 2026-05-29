# Chesstein Worker

Cloudflare Worker backend for Chesstein multiplayer rooms.

The frontend can stay on GitHub Pages. This Worker only handles backend work:

- create public/private rooms
- list only waiting public rooms
- one WebSocket endpoint per room
- one Durable Object per game room
- a lobby Durable Object for public room listings
- waiting -> active -> cancelled/abandoned room lifecycle
- creator is White, second player is Black
- relay/store FEN and move history

It does **not** validate chess moves yet. That should be a later pass with `chess.js` or explicit validation logic.

## Folder placement

Put this folder in the root of your GitHub Pages repo:

```text
jsippis.github.io/
  smartchess/          # current frontend, still hosted by GitHub Pages
  chesstein-worker/    # this backend, deployed by Cloudflare Workers
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
