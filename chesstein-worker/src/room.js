const START_FEN = 'startpos';
const MAX_PUBLIC_ROOMS = 50;

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase();
}

function sanitizeClientType(value) {
  const text = String(value || '').toLowerCase();
  if (['gui', 'bridge', 'spectator', 'bot'].includes(text)) return text;
  return 'gui';
}

function sanitizeRequestedColor(value) {
  const text = String(value || '').toLowerCase();
  if (['white', 'black', 'spectator'].includes(text)) return text;
  return '';
}

function initialSnapshot(roomCode) {
  const time = nowIso();
  return {
    roomCode,
    visibility: 'private',
    mode: 'multiplayer',
    status: 'waiting',
    createdAt: time,
    updatedAt: time,
    fen: START_FEN,
    history: [],
    players: {
      white: null,
      black: null,
    },
    spectators: 0,
  };
}

function publicRoomSummary(snapshot) {
  return {
    roomCode: snapshot.roomCode,
    visibility: snapshot.visibility,
    mode: snapshot.mode,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    players: {
      white: snapshot.players?.white ? { name: snapshot.players.white.name, clientType: snapshot.players.white.clientType } : null,
      black: snapshot.players?.black ? { name: snapshot.players.black.name, clientType: snapshot.players.black.clientType } : null,
    },
    spectators: snapshot.spectators || 0,
  };
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/list') {
      const rooms = await this.storage.get('publicRooms') || [];
      const visibleRooms = rooms
        .filter((room) => room.visibility === 'public')
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, MAX_PUBLIC_ROOMS);
      return Response.json({ ok: true, rooms: visibleRooms });
    }

    if (request.method === 'POST' && url.pathname === '/rooms') {
      const payload = await request.json();
      const existing = await this.storage.get('publicRooms') || [];
      const summary = publicRoomSummary(payload);
      const rooms = [summary, ...existing.filter((room) => room.roomCode !== summary.roomCode)]
        .slice(0, MAX_PUBLIC_ROOMS);
      await this.storage.put('publicRooms', rooms);
      return Response.json({ ok: true, room: summary });
    }

    if (request.method === 'PATCH' && url.pathname === '/rooms') {
      const payload = await request.json();
      const existing = await this.storage.get('publicRooms') || [];
      const summary = publicRoomSummary(payload);
      const rooms = [summary, ...existing.filter((room) => room.roomCode !== summary.roomCode)]
        .slice(0, MAX_PUBLIC_ROOMS);
      await this.storage.put('publicRooms', rooms);
      return Response.json({ ok: true, room: summary });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/rooms/')) {
      const roomCode = normalizeRoomCode(url.pathname.split('/').pop());
      const existing = await this.storage.get('publicRooms') || [];
      const rooms = existing.filter((room) => room.roomCode !== roomCode);
      await this.storage.put('publicRooms', rooms);
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.snapshot = null;
  }

  async loadSnapshot(roomCode = 'UNKNOWN') {
    if (!this.snapshot) {
      this.snapshot = await this.storage.get('snapshot') || initialSnapshot(roomCode);
    }
    return this.snapshot;
  }

  async saveSnapshot() {
    if (!this.snapshot) return;
    this.snapshot.updatedAt = nowIso();
    this.snapshot.spectators = Array.from(this.sessions.values())
      .filter((session) => session.color === 'spectator').length;
    await this.storage.put('snapshot', this.snapshot);
    await this.updateLobby();
  }

  async updateLobby() {
    if (!this.snapshot || this.snapshot.visibility !== 'public' || !this.env.LOBBY) return;
    const id = this.env.LOBBY.idFromName('global');
    const lobby = this.env.LOBBY.get(id);
    await lobby.fetch(new Request('https://lobby/rooms', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.snapshot),
    }));
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/init') {
      const payload = await request.json();
      const existing = await this.storage.get('snapshot');
      if (!existing) {
        this.snapshot = {
          ...initialSnapshot(payload.roomCode),
          ...payload,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          players: { white: null, black: null },
          spectators: 0,
        };
        await this.saveSnapshot();
      } else {
        this.snapshot = existing;
      }
      return Response.json({ ok: true, room: publicRoomSummary(this.snapshot) });
    }

    if (request.method === 'GET' && url.pathname === '/snapshot') {
      const roomCode = normalizeRoomCode(url.searchParams.get('roomCode')) || 'UNKNOWN';
      const snapshot = await this.loadSnapshot(roomCode);
      return Response.json({ ok: true, room: snapshot });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  async handleWebSocket(request) {
    const url = new URL(request.url);
    const roomCode = normalizeRoomCode(url.pathname.split('/').pop());
    await this.loadSnapshot(roomCode);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const session = this.createSession(url);
    server.accept();
    this.sessions.set(server, session);

    this.assignSeat(session);
    await this.saveSnapshot();

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data).catch((error) => {
        this.send(server, { type: 'error', message: error?.message || 'message_failed' });
      });
    });

    server.addEventListener('close', () => {
      this.closeSession(server).catch(() => {});
    });

    server.addEventListener('error', () => {
      this.closeSession(server).catch(() => {});
    });

    this.send(server, {
      type: 'welcome',
      session,
      room: this.snapshot,
      serverTime: nowIso(),
    });

    this.broadcast({
      type: 'presence',
      room: publicRoomSummary(this.snapshot),
      sessions: this.publicSessions(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  createSession(url) {
    const id = crypto.randomUUID();
    const requestedColor = sanitizeRequestedColor(url.searchParams.get('color'));
    const clientType = sanitizeClientType(url.searchParams.get('client'));
    const name = String(url.searchParams.get('name') || 'anon').slice(0, 32);

    return {
      id,
      name,
      clientType,
      requestedColor,
      color: 'spectator',
      joinedAt: nowIso(),
    };
  }

  assignSeat(session) {
    if (session.requestedColor === 'spectator') {
      session.color = 'spectator';
      return;
    }

    const desired = session.requestedColor;
    const fallback = desired === 'black' ? 'white' : 'black';
    const candidates = desired ? [desired, fallback] : ['white', 'black'];

    for (const color of candidates) {
      if (!this.snapshot.players[color]) {
        session.color = color;
        this.snapshot.players[color] = {
          id: session.id,
          name: session.name,
          clientType: session.clientType,
          joinedAt: session.joinedAt,
        };
        this.snapshot.status = this.snapshot.players.white && this.snapshot.players.black ? 'active' : 'waiting';
        return;
      }
    }

    session.color = 'spectator';
  }

  async closeSession(socket) {
    const session = this.sessions.get(socket);
    if (!session) return;

    this.sessions.delete(socket);

    if (session.color === 'white' || session.color === 'black') {
      const player = this.snapshot?.players?.[session.color];
      if (player?.id === session.id) {
        this.snapshot.players[session.color] = null;
        this.snapshot.status = 'waiting';
      }
    }

    await this.saveSnapshot();
    this.broadcast({
      type: 'presence',
      room: publicRoomSummary(this.snapshot),
      sessions: this.publicSessions(),
    });
  }

  async handleMessage(socket, rawData) {
    const session = this.sessions.get(socket);
    if (!session) return;

    const message = typeof rawData === 'string' ? safeJsonParse(rawData) : null;
    if (!message || typeof message.type !== 'string') {
      this.send(socket, { type: 'error', message: 'Messages must be JSON with a type field.' });
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(socket, { type: 'pong', serverTime: nowIso() });
        break;

      case 'request_sync':
        this.send(socket, { type: 'sync', room: this.snapshot, sessions: this.publicSessions() });
        break;

      case 'move':
      case 'fen':
      case 'board_update':
        await this.applyBoardUpdate(session, message);
        break;

      case 'reset':
      case 'new_game':
        await this.resetGame(session, message);
        break;

      case 'chat':
        this.broadcast({
          type: 'chat',
          from: this.publicSession(session),
          text: String(message.text || '').slice(0, 500),
          createdAt: nowIso(),
        });
        break;

      default:
        this.send(socket, { type: 'error', message: `Unknown message type: ${message.type}` });
    }
  }

  async applyBoardUpdate(session, message) {
    if (typeof message.fen === 'string' && message.fen.trim()) {
      this.snapshot.fen = message.fen.trim();
    }

    if (Array.isArray(message.history)) {
      this.snapshot.history = message.history.slice(-300);
    } else if (message.san || message.uci) {
      this.snapshot.history = [
        ...(this.snapshot.history || []),
        {
          san: message.san || null,
          uci: message.uci || null,
          by: session.color,
          at: nowIso(),
        },
      ].slice(-300);
    }

    this.snapshot.status = message.status || this.snapshot.status || 'active';
    await this.saveSnapshot();

    this.broadcast({
      type: 'room_update',
      reason: message.type,
      from: this.publicSession(session),
      room: this.snapshot,
      move: {
        uci: message.uci || null,
        san: message.san || null,
      },
    });
  }

  async resetGame(session, message) {
    this.snapshot.fen = typeof message.fen === 'string' ? message.fen : START_FEN;
    this.snapshot.history = [];
    this.snapshot.status = this.snapshot.players.white && this.snapshot.players.black ? 'active' : 'waiting';
    await this.saveSnapshot();

    this.broadcast({
      type: 'game_reset',
      from: this.publicSession(session),
      room: this.snapshot,
    });
  }

  publicSession(session) {
    return {
      id: session.id,
      name: session.name,
      clientType: session.clientType,
      color: session.color,
      joinedAt: session.joinedAt,
    };
  }

  publicSessions() {
    return Array.from(this.sessions.values()).map((session) => this.publicSession(session));
  }

  send(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore dead sockets; close handler will clean up when the runtime reports it.
    }
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const socket of this.sessions.keys()) {
      try {
        socket.send(data);
      } catch {
        // Ignore dead sockets.
      }
    }
  }
}
