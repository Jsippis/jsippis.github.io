# Chesstein Worker

Cloudflare Worker backend for Chesstein multiplayer rooms.

The frontend can stay on GitHub Pages. This Worker only handles backend work:

- create public/private rooms
- list public rooms
- one WebSocket endpoint per room
- one Durable Object per game room
- a lobby Durable Object for public room listings
- relay/store FEN, move history, resets, presence, and chat-like messages

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
  -d '{"visibility":"public","mode":"multiplayer"}'
```

List public rooms:

```powershell
curl http://127.0.0.1:8787/api/rooms
```

## Deploy from terminal

```powershell
cd chesstein-worker
npm install
npx wrangler login
npm run deploy
```

After deployment, Cloudflare will give you a `workers.dev` URL.

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

Create a room.

```json
{
  "visibility": "public",
  "mode": "multiplayer"
}
```

Response includes:

```json
{
  "ok": true,
  "roomCode": "ABC123",
  "wsUrl": "wss://.../ws/rooms/ABC123"
}
```

### `GET /api/rooms`

List public rooms.

### `GET /api/rooms/:roomCode`

Get a room snapshot.

### `GET /ws/rooms/:roomCode`

WebSocket endpoint.

Client example:

```js
const ws = new WebSocket(
  "wss://your-worker.workers.dev/ws/rooms/ABC123?client=gui&name=Joonas&color=white"
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
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
}));
```

Reset game:

```js
ws.send(JSON.stringify({ type: "new_game" }));
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
