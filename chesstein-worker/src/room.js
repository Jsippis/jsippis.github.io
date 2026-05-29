const START_FEN = 'startpos';
const MAX_PUBLIC_ROOMS = 50;
const EMPTY_ROOM_TTL_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value) {
  try { return JSON.parse(value); }
  catch { return null; }
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sanitizeClientType(value) {
  const text = String(value || '').toLowerCase();
  if (['gui', 'bridge', 'spectator', 'bot'].includes(text)) return text;
  return 'gui';
}

function sanitizeVisibility(value) {
  return String(value || '').toLowerCase() === 'public' ? 'public' : 'private';
}

function sanitizeName(value) {
  return String(value || 'Player').trim().slice(0, 32) || 'Player';
}

function initialSnapshot(roomCode) {
  const time = nowIso();
  return {
    roomCode,
    visibility: 'private',
    status: 'waiting',
    createdAt: time,
    updatedAt: time,
    startedAt: null,
    endedAt: null,
    fen: START_FEN,
    history: [],
    players: { white: null, black: null },
    spectators: 0,
    result: null,
    endReason: null,
    drawOfferBy: null,
  };
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    name: player.name,
    clientType: player.clientType,
    connected: !!player.connected,
    joinedAt: player.joinedAt,
  };
}

function publicRoomSummary(snapshot) {
  return {
    roomCode: snapshot.roomCode,
    visibility: snapshot.visibility,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt || null,
    players: {
      white: publicPlayer(snapshot.players?.white),
      black: publicPlayer(snapshot.players?.black),
    },
    spectators: snapshot.spectators || 0,
  };
}

function publicSnapshot(snapshot) {
  return {
    ...snapshot,
    players: {
      white: publicPlayer(snapshot.players?.white),
      black: publicPlayer(snapshot.players?.black),
    },
  };
}

function playerMatches(player, token) {
  return !!player && !!token && player.token === token;
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
        .filter((room) => room.visibility === 'public' && room.status === 'waiting')
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, MAX_PUBLIC_ROOMS);
      return Response.json({ ok: true, rooms: visibleRooms });
    }

    if ((request.method === 'POST' || request.method === 'PATCH') && url.pathname === '/rooms') {
      const payload = await request.json();
      const existing = await this.storage.get('publicRooms') || [];

      if (payload.visibility !== 'public' || payload.status !== 'waiting') {
        const rooms = existing.filter((room) => room.roomCode !== payload.roomCode);
        await this.storage.put('publicRooms', rooms);
        return Response.json({ ok: true, removed: true });
      }

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

  async alarm() {
    await this.loadSnapshot();
    if (this.sessions.size > 0) return;

    if (this.snapshot.status === 'waiting' || this.snapshot.status === 'active') {
      this.snapshot.status = 'abandoned';
      this.snapshot.updatedAt = nowIso();
      this.snapshot.players.white = null;
      this.snapshot.players.black = null;
      await this.storage.put('snapshot', this.snapshot);
      await this.removeFromLobby();
    }
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
    if (!this.env.LOBBY || !this.snapshot) return;
    const id = this.env.LOBBY.idFromName('global');
    const lobby = this.env.LOBBY.get(id);
    if (this.snapshot.visibility === 'public' && this.snapshot.status === 'waiting') {
      await lobby.fetch(new Request('https://lobby/rooms', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.snapshot),
      }));
    } else {
      await lobby.fetch(new Request(`https://lobby/rooms/${this.snapshot.roomCode}`, { method: 'DELETE' }));
    }
  }

  async removeFromLobby() {
    if (!this.env.LOBBY || !this.snapshot) return;
    const id = this.env.LOBBY.idFromName('global');
    const lobby = this.env.LOBBY.get(id);
    await lobby.fetch(new Request(`https://lobby/rooms/${this.snapshot.roomCode}`, { method: 'DELETE' }));
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/init') {
      const payload = await request.json();
      const existing = await this.storage.get('snapshot');
      if (!existing) {
        const token = String(payload.playerToken || crypto.randomUUID());
        const roomCode = normalizeRoomCode(payload.roomCode);
        this.snapshot = {
          ...initialSnapshot(roomCode),
          roomCode,
          visibility: sanitizeVisibility(payload.visibility),
          players: {
            white: {
              token,
              name: sanitizeName(payload.name),
              clientType: sanitizeClientType(payload.clientType),
              connected: false,
              joinedAt: nowIso(),
            },
            black: null,
          },
        };
        await this.saveSnapshot();
      } else {
        this.snapshot = existing;
      }
      return Response.json({ ok: true, room: publicSnapshot(this.snapshot) });
    }

    if (request.method === 'GET' && url.pathname === '/snapshot') {
      const roomCode = normalizeRoomCode(url.searchParams.get('roomCode')) || 'UNKNOWN';
      const snapshot = await this.loadSnapshot(roomCode);
      return Response.json({ ok: true, room: publicSnapshot(snapshot) });
    }

    if (request.method === 'DELETE' && url.pathname === '/cancel') {
      const token = String(url.searchParams.get('token') || '');
      await this.loadSnapshot(normalizeRoomCode(url.searchParams.get('roomCode')) || 'UNKNOWN');
      if (!playerMatches(this.snapshot.players.white, token)) {
        return Response.json({ ok: false, error: 'not_room_creator' }, { status: 403 });
      }
      await this.cancelRoom('cancelled');
      return Response.json({ ok: true });
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

    if (['cancelled', 'abandoned', 'finished'].includes(this.snapshot.status)) {
      return new Response('Room is closed.', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = this.createSession(url);

    server.accept();
    this.sessions.set(server, session);

    const previousStatus = this.snapshot.status;
    this.assignSeat(session);
    await this.saveSnapshot();

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data).catch((error) => {
        this.send(server, { type: 'error', message: error?.message || 'message_failed' });
      });
    });

    server.addEventListener('close', () => this.closeSession(server).catch(() => {}));
    server.addEventListener('error', () => this.closeSession(server).catch(() => {}));

    this.send(server, {
      type: 'welcome',
      session: this.publicSession(session),
      playerColor: session.color,
      room: publicSnapshot(this.snapshot),
      serverTime: nowIso(),
    });

    if (previousStatus !== 'active' && this.snapshot.status === 'active') {
      await this.broadcastGameStarted();
    } else {
      this.broadcastPresence();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  createSession(url) {
    const token = String(url.searchParams.get('token') || crypto.randomUUID());
    const clientType = sanitizeClientType(url.searchParams.get('client'));
    const name = sanitizeName(url.searchParams.get('name'));

    return {
      id: crypto.randomUUID(),
      token,
      name,
      clientType,
      color: 'spectator',
      joinedAt: nowIso(),
    };
  }

  assignSeat(session) {
    if (playerMatches(this.snapshot.players.white, session.token)) {
      session.color = 'white';
      this.snapshot.players.white.connected = true;
      this.snapshot.players.white.name = session.name;
      this.snapshot.players.white.clientType = session.clientType;
      return;
    }

    if (playerMatches(this.snapshot.players.black, session.token)) {
      session.color = 'black';
      this.snapshot.players.black.connected = true;
      this.snapshot.players.black.name = session.name;
      this.snapshot.players.black.clientType = session.clientType;
      return;
    }

    if (this.snapshot.status === 'waiting' && !this.snapshot.players.black) {
      session.color = 'black';
      this.snapshot.players.black = {
        token: session.token,
        name: session.name,
        clientType: session.clientType,
        connected: true,
        joinedAt: session.joinedAt,
      };
      this.snapshot.status = 'active';
      this.snapshot.startedAt = nowIso();
      return;
    }

    session.color = 'spectator';
  }

  async closeSession(socket) {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);

    const stillConnected = Array.from(this.sessions.values())
      .some((other) => other.token === session.token);

    if (!stillConnected && (session.color === 'white' || session.color === 'black')) {
      const player = this.snapshot?.players?.[session.color];
      if (playerMatches(player, session.token)) {
        player.connected = false;
      }
    }

    await this.saveSnapshot();
    this.broadcastPresence();

    if (this.sessions.size === 0) {
      await this.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
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
        this.send(socket, { type: 'sync', room: publicSnapshot(this.snapshot), sessions: this.publicSessions() });
        break;

      case 'move':
      case 'fen':
      case 'board_update':
        await this.applyBoardUpdate(session, message);
        break;

      case 'cancel_room':
        if (!playerMatches(this.snapshot.players.white, session.token)) {
          this.send(socket, { type: 'error', message: 'Only the room creator can cancel this room.' });
          return;
        }
        await this.cancelRoom('cancelled');
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
    if (this.snapshot.status !== 'active') {
      this.sendToToken(session.token, { type: 'error', message: 'Game has not started yet.' });
      return;
    }

    if (session.color !== 'white' && session.color !== 'black') {
      this.sendToToken(session.token, { type: 'error', message: 'Spectators cannot move.' });
      return;
    }

    if (typeof message.fen === 'string' && message.fen.trim()) {
      this.snapshot.fen = message.fen.trim();
    }

    if (Array.isArray(message.history)) {
      this.snapshot.history = message.history.slice(-300);
    } else if (message.san || message.uci) {
      this.snapshot.history = [
        ...(this.snapshot.history || []),
        { san: message.san || message.uci || null, uci: message.uci || null, by: session.color, at: nowIso() },
      ].slice(-300);
    }

    this.snapshot.drawOfferBy = null;
    await this.saveSnapshot();

    this.broadcast({
      type: 'room_update',
      reason: message.type,
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
      move: { uci: message.uci || null, san: message.san || null },
    });
  }

  async cancelRoom(status = 'cancelled') {
    this.snapshot.status = status;
    this.snapshot.updatedAt = nowIso();
    await this.saveSnapshot();
    await this.removeFromLobby();
    this.broadcast({ type: 'cancelled', room: publicSnapshot(this.snapshot) });
    for (const socket of this.sessions.keys()) {
      try { socket.close(1000, 'room_cancelled'); } catch {}
    }
  }

  async broadcastGameStarted() {
    await this.removeFromLobby();
    for (const [socket, session] of this.sessions.entries()) {
      this.send(socket, {
        type: 'game_started',
        playerColor: session.color,
        session: this.publicSession(session),
        room: publicSnapshot(this.snapshot),
      });
    }
  }

  broadcastPresence() {
    this.broadcast({
      type: 'presence',
      room: publicRoomSummary(this.snapshot),
      sessions: this.publicSessions(),
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

  sendToToken(token, payload) {
    for (const [socket, session] of this.sessions.entries()) {
      if (session.token === token) this.send(socket, payload);
    }
  }

  send(socket, payload) {
    try { socket.send(JSON.stringify(payload)); }
    catch {}
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const socket of this.sessions.keys()) {
      try { socket.send(data); }
      catch {}
    }
  }
}
