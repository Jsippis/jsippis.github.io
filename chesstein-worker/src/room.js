import { Chess } from 'chess.js';

const START_FEN = 'startpos';
const MAX_PUBLIC_ROOMS = 50;
const EMPTY_ROOM_TTL_MS = 30_000;
const FINISHED_ROOM_TTL_MS = 5 * 60_000;
const BRIDGE_TOKEN_TTL_MS = 5 * 60_000;

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
  if (['gui', 'bridge', 'companion', 'spectator', 'bot'].includes(text)) return text;
  return 'gui';
}

function sanitizeVisibility(value) {
  return String(value || '').toLowerCase() === 'public' ? 'public' : 'private';
}

function sanitizeRole(value, clientType = 'gui') {
  const text = String(value || '').toLowerCase();
  if (['player', 'bridge', 'companion', 'spectator'].includes(text)) return text;
  const type = sanitizeClientType(clientType);
  if (type === 'bridge') return 'bridge';
  if (type === 'companion') return 'companion';
  if (type === 'spectator') return 'spectator';
  return 'player';
}

function roleCanClaimSeat(role) {
  return role === 'player' || role === 'bridge';
}

function sanitizeClientId(value) {
  return String(value || '').trim().slice(0, 80);
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
    rematchOfferBy: null,
    turn: 'white',
  };
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    name: player.name,
    clientType: player.clientType,
    role: player.role || (player.clientType === 'bridge' ? 'bridge' : 'player'),
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
  if (!player || !token || player.token !== token) return false;
  if (player.tokenExpiresAt && Date.parse(player.tokenExpiresAt) < Date.now()) return false;
  return true;
}

function bridgeTokenExpiresAt() {
  return new Date(Date.now() + BRIDGE_TOKEN_TTL_MS).toISOString();
}

function otherColor(color) {
  return color === 'white' ? 'black' : color === 'black' ? 'white' : null;
}

function resultForResignation(color) {
  return color === 'white' ? '0-1' : '1-0';
}

function colorToTurn(color) {
  return color === 'black' ? 'b' : 'w';
}

function turnToColor(turn) {
  return turn === 'b' ? 'black' : 'white';
}

function chessFromFen(fen) {
  if (!fen || fen === START_FEN || fen === 'startpos') return new Chess();
  return new Chess(String(fen).trim());
}

function parseUciMove(uci) {
  const text = String(uci || '').trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) return null;
  return {
    from: text.slice(0, 2),
    to: text.slice(2, 4),
    promotion: text.length > 4 ? text[4] : undefined,
  };
}

function sanitizeSquareIndex(value) {
  const square = Number(value);
  return Number.isInteger(square) && square >= 0 && square <= 63 ? square : null;
}

function sanitizeSquareName(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-h][1-8]$/.test(text) ? text : null;
}

function sanitizeUciList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(item))
    .slice(0, 32);
}

function gameOverInfo(chess, moverColor) {
  if (chess.isCheckmate()) {
    return {
      result: moverColor === 'white' ? '1-0' : '0-1',
      reason: `${turnToColor(chess.turn())}_checkmated`,
    };
  }
  if (typeof chess.isStalemate === 'function' && chess.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
  if (typeof chess.isInsufficientMaterial === 'function' && chess.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient_material' };
  if (typeof chess.isThreefoldRepetition === 'function' && chess.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'threefold_repetition' };
  if (typeof chess.isDraw === 'function' && chess.isDraw()) return { result: '1/2-1/2', reason: 'draw' };
  return null;
}

function turnColorFromFen(fen) {
  if (!fen || fen === START_FEN || fen === START_FEN.split(' ')[0] || fen === 'startpos') return 'white';
  const parts = String(fen).trim().split(/\s+/);
  return parts[1] === 'b' ? 'black' : 'white';
}

function publicDrawOffer(drawOfferBy) {
  return drawOfferBy || null;
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
      this.snapshot.endedAt = this.snapshot.endedAt || nowIso();
      this.snapshot.endReason = 'empty_room';
      this.snapshot.players.white = null;
      this.snapshot.players.black = null;
      await this.storage.put('snapshot', this.snapshot);
      await this.removeFromLobby();
      return;
    }

    if (this.snapshot.status === 'finished') {
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
              role: sanitizeRole(payload.role, payload.clientType),
              clientId: sanitizeClientId(payload.clientId),
              tokenExpiresAt: sanitizeRole(payload.role, payload.clientType) === 'bridge' ? bridgeTokenExpiresAt() : null,
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

    if (request.method === 'POST' && url.pathname === '/bridge-token') {
      const payload = await request.json().catch(() => ({}));
      await this.loadSnapshot(normalizeRoomCode(url.searchParams.get('roomCode')) || 'UNKNOWN');
      return this.reserveBridgeSeat(payload);
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
    const role = sanitizeRole(url.searchParams.get('role'), clientType);
    const name = sanitizeName(url.searchParams.get('name'));
    const clientId = sanitizeClientId(url.searchParams.get('clientId'));

    return {
      id: crypto.randomUUID(),
      token,
      name,
      clientType,
      role,
      clientId,
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
      this.snapshot.players.white.role = session.role;
      this.snapshot.players.white.clientId = session.clientId || this.snapshot.players.white.clientId || '';
      this.snapshot.players.white.tokenExpiresAt = null;
      this.startIfReady();
      return;
    }

    if (playerMatches(this.snapshot.players.black, session.token)) {
      session.color = 'black';
      this.snapshot.players.black.connected = true;
      this.snapshot.players.black.name = session.name;
      this.snapshot.players.black.clientType = session.clientType;
      this.snapshot.players.black.role = session.role;
      this.snapshot.players.black.clientId = session.clientId || this.snapshot.players.black.clientId || '';
      this.snapshot.players.black.tokenExpiresAt = null;
      this.startIfReady();
      return;
    }

    const sameClientAlreadyPlays = !!session.clientId && ['white', 'black'].some((color) => {
      const player = this.snapshot.players?.[color];
      return player?.clientId && player.clientId === session.clientId;
    });

    if (!sameClientAlreadyPlays && roleCanClaimSeat(session.role) && this.snapshot.status === 'waiting' && !this.snapshot.players.black) {
      session.color = 'black';
      this.snapshot.players.black = {
        token: session.token,
        name: session.name,
        clientType: session.clientType,
        role: session.role,
        clientId: session.clientId || '',
        connected: true,
        joinedAt: session.joinedAt,
      };
      this.startIfReady();
      return;
    }

    session.color = 'spectator';
  }

  startIfReady() {
    if (this.snapshot.status !== 'waiting') return;
    if (this.snapshot.players.white?.connected && this.snapshot.players.black?.connected) {
      this.snapshot.status = 'active';
      this.snapshot.startedAt = nowIso();
    }
  }

  async reserveBridgeSeat(payload) {
    if (!this.snapshot || !this.snapshot.roomCode || this.snapshot.roomCode === 'UNKNOWN') {
      return Response.json({ ok: false, error: 'room_not_found' }, { status: 404 });
    }

    if (['cancelled', 'abandoned', 'finished'].includes(this.snapshot.status)) {
      return Response.json({ ok: false, error: 'room_closed' }, { status: 409 });
    }

    if (this.snapshot.status !== 'waiting') {
      return Response.json({ ok: false, error: 'room_already_active' }, { status: 409 });
    }

    if (this.snapshot.players.black && this.snapshot.players.black.clientType !== 'bridge') {
      return Response.json({ ok: false, error: 'black_already_taken' }, { status: 409 });
    }

    const token = crypto.randomUUID();
    this.snapshot.players.black = {
      token,
      name: sanitizeName(payload.name || 'Physical board'),
      clientType: 'bridge',
      role: 'bridge',
      clientId: sanitizeClientId(payload.clientId),
      tokenExpiresAt: bridgeTokenExpiresAt(),
      connected: false,
      joinedAt: nowIso(),
    };
    await this.saveSnapshot();
    return Response.json({
      ok: true,
      roomCode: this.snapshot.roomCode,
      color: 'black',
      bridgeJoinToken: token,
      room: publicSnapshot(this.snapshot),
    });
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

    if (this.snapshot?.status === 'waiting' && session.color === 'white' && !stillConnected) {
      this.snapshot.status = 'abandoned';
      this.snapshot.endedAt = nowIso();
      this.snapshot.endReason = 'host_left';
      await this.saveSnapshot();
      await this.removeFromLobby();
      this.broadcast({ type: 'room_closed', room: publicSnapshot(this.snapshot) });
      for (const socket of this.sessions.keys()) {
        try { socket.close(1000, 'host_left'); } catch {}
      }
      return;
    }

    await this.saveSnapshot();
    this.broadcastPresence();

    if (this.sessions.size === 0) {
      await this.removeFromLobby();
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

      case 'legal_moves':
        // Older GUI builds sent bridge-only legal move preview requests to the
        // room backend. Legal move preview is client-side for online rooms;
        // keep this as a no-op so old clients do not see an error toast.
        break;

      case 'physical_lift':
        await this.broadcastPhysicalLift(session, message);
        break;

      case 'physical_place':
        await this.broadcastPhysicalPlace(session, message);
        break;

      case 'move':
      case 'fen':
      case 'board_update':
        await this.applyBoardUpdate(session, message);
        break;

      case 'draw_offer':
        await this.offerDraw(session);
        break;

      case 'draw_accept':
        await this.acceptDraw(session);
        break;

      case 'draw_decline':
        await this.declineDraw(session);
        break;

      case 'resign':
      case 'forfeit':
        await this.resign(session);
        break;

      case 'rematch_offer':
        await this.offerRematch(session);
        break;

      case 'rematch_accept':
        await this.acceptRematch(session);
        break;

      case 'rematch_decline':
        await this.declineRematch(session);
        break;

      case 'leave_room':
        try { socket.close(1000, 'client_left'); } catch {}
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

  ensureActivePlayer(session) {
    if (this.snapshot.status !== 'active') {
      return 'Game has not started yet.';
    }

    if (session.color !== 'white' && session.color !== 'black') {
      return 'Spectators cannot act in this game.';
    }

    return null;
  }

  ensureBridgePlayer(session) {
    if (this.snapshot.status !== 'active' && this.snapshot.status !== 'finished') {
      return 'Room is not active.';
    }

    if (session.role !== 'bridge' || session.color !== 'white' && session.color !== 'black') {
      return 'Only a physical-board player can send physical board events.';
    }

    return null;
  }

  async broadcastPhysicalLift(session, message) {
    const playerError = this.ensureBridgePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    const square = sanitizeSquareIndex(message.square);
    if (square === null) {
      this.sendToToken(session.token, { type: 'error', message: 'Physical lift needs a square index.' });
      return;
    }

    const squareName = sanitizeSquareName(message.square_name || message.squareName) || null;
    const moves = sanitizeUciList(message.moves);
    this.broadcast({
      type: 'physical_lift',
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
      square,
      square_name: squareName,
      moves,
      message: squareName
        ? `Physical board lifted ${squareName.toUpperCase()}.`
        : 'Physical board piece lifted.',
    });
  }

  async broadcastPhysicalPlace(session, message) {
    const playerError = this.ensureBridgePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    const square = sanitizeSquareIndex(message.square);
    if (square === null) {
      this.sendToToken(session.token, { type: 'error', message: 'Physical place needs a square index.' });
      return;
    }

    const squareName = sanitizeSquareName(message.square_name || message.squareName) || null;
    const clearsSelection = !!(message.clears_selection || message.clearsSelection);
    this.broadcast({
      type: 'physical_place',
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
      square,
      square_name: squareName,
      clears_selection: clearsSelection,
      message: clearsSelection
        ? 'Physical board piece returned.'
        : 'Physical board piece placed.',
    });
  }

  async applyBoardUpdate(session, message) {
    const playerError = this.ensureActivePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    const chess = chessFromFen(this.snapshot.fen);
    const expectedTurn = turnToColor(chess.turn());
    if (expectedTurn !== session.color) {
      this.sendToToken(session.token, { type: 'error', message: `It is ${expectedTurn}'s turn.` });
      return;
    }

    const parsed = parseUciMove(message.uci);
    if (!parsed) {
      this.sendToToken(session.token, { type: 'error', message: 'Move must be a UCI move such as e2e4.' });
      return;
    }

    let applied;
    try {
      applied = chess.move(parsed);
    } catch {
      applied = null;
    }

    if (!applied) {
      this.sendToToken(session.token, { type: 'move_illegal', uci: message.uci || null });
      return;
    }

    const uci = `${applied.from}${applied.to}${applied.promotion || ''}`;
    this.snapshot.fen = chess.fen();
    this.snapshot.turn = turnToColor(chess.turn());
    this.snapshot.history = [
      ...(this.snapshot.history || []),
      { san: applied.san || uci, uci, by: session.color, at: nowIso() },
    ].slice(-300);
    this.snapshot.drawOfferBy = null;
    this.snapshot.rematchOfferBy = null;

    const over = gameOverInfo(chess, session.color);
    await this.saveSnapshot();

    this.broadcast({
      type: 'room_update',
      reason: 'move',
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
      move: { uci, san: applied.san || null },
    });

    if (over) {
      await this.finishGame({
        result: over.result,
        reason: over.reason,
        by: session.color,
      });
    }
  }

  async offerDraw(session) {
    const playerError = this.ensureActivePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    if (this.snapshot.drawOfferBy === session.color) {
      this.sendToToken(session.token, { type: 'status', message: 'Draw offer already sent.' });
      return;
    }

    this.snapshot.drawOfferBy = session.color;
    await this.saveSnapshot();

    this.broadcast({
      type: 'draw_offer',
      offeredBy: session.color,
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
    });
  }

  async acceptDraw(session) {
    const playerError = this.ensureActivePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    const offerBy = publicDrawOffer(this.snapshot.drawOfferBy);
    if (!offerBy) {
      this.sendToToken(session.token, { type: 'error', message: 'There is no draw offer to accept.' });
      return;
    }

    if (offerBy === session.color) {
      this.sendToToken(session.token, { type: 'error', message: 'You cannot accept your own draw offer.' });
      return;
    }

    await this.finishGame({
      result: '1/2-1/2',
      reason: 'draw_agreed',
      by: session.color,
    });
  }

  async declineDraw(session) {
    const playerError = this.ensureActivePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    const offerBy = publicDrawOffer(this.snapshot.drawOfferBy);
    if (!offerBy) {
      this.sendToToken(session.token, { type: 'error', message: 'There is no draw offer to decline.' });
      return;
    }

    if (offerBy === session.color) {
      this.sendToToken(session.token, { type: 'error', message: 'You cannot decline your own draw offer.' });
      return;
    }

    this.snapshot.drawOfferBy = null;
    this.snapshot.rematchOfferBy = null;
    await this.saveSnapshot();
    this.broadcast({
      type: 'draw_declined',
      declinedBy: session.color,
      room: publicSnapshot(this.snapshot),
    });
  }

  async resign(session) {
    const playerError = this.ensureActivePlayer(session);
    if (playerError) {
      this.sendToToken(session.token, { type: 'error', message: playerError });
      return;
    }

    await this.finishGame({
      result: resultForResignation(session.color),
      reason: `${session.color}_resigned`,
      by: session.color,
    });
  }

  async offerRematch(session) {
    if (this.snapshot.status !== 'finished') {
      this.sendToToken(session.token, { type: 'error', message: 'Rematch is only available after the game ends.' });
      return;
    }

    if (session.color !== 'white' && session.color !== 'black') {
      this.sendToToken(session.token, { type: 'error', message: 'Spectators cannot request a rematch.' });
      return;
    }

    this.snapshot.rematchOfferBy = session.color;
    await this.saveSnapshot();
    this.broadcast({
      type: 'rematch_offer',
      offeredBy: session.color,
      from: this.publicSession(session),
      room: publicSnapshot(this.snapshot),
    });
  }

  async acceptRematch(session) {
    if (this.snapshot.status !== 'finished') {
      this.sendToToken(session.token, { type: 'error', message: 'This game is not finished yet.' });
      return;
    }

    if (session.color !== 'white' && session.color !== 'black') {
      this.sendToToken(session.token, { type: 'error', message: 'Spectators cannot accept a rematch.' });
      return;
    }

    if (!this.snapshot.rematchOfferBy) {
      this.sendToToken(session.token, { type: 'error', message: 'There is no rematch offer to accept.' });
      return;
    }

    if (this.snapshot.rematchOfferBy === session.color) {
      this.sendToToken(session.token, { type: 'error', message: 'You cannot accept your own rematch offer.' });
      return;
    }

    await this.startRematch();
  }

  async declineRematch(session) {
    if (this.snapshot.status !== 'finished') {
      this.sendToToken(session.token, { type: 'error', message: 'This game is not finished yet.' });
      return;
    }

    if (!this.snapshot.rematchOfferBy) {
      this.sendToToken(session.token, { type: 'error', message: 'There is no rematch offer to decline.' });
      return;
    }

    if (this.snapshot.rematchOfferBy === session.color) {
      this.sendToToken(session.token, { type: 'error', message: 'You cannot decline your own rematch offer.' });
      return;
    }

    this.snapshot.rematchOfferBy = null;
    await this.saveSnapshot();
    this.broadcast({
      type: 'rematch_declined',
      declinedBy: session.color,
      room: publicSnapshot(this.snapshot),
    });
  }

  async startRematch() {
    const time = nowIso();
    this.snapshot.status = 'active';
    this.snapshot.fen = START_FEN;
    this.snapshot.history = [];
    this.snapshot.result = null;
    this.snapshot.endReason = null;
    this.snapshot.drawOfferBy = null;
    this.snapshot.rematchOfferBy = null;
    this.snapshot.turn = 'white';
    this.snapshot.startedAt = time;
    this.snapshot.endedAt = null;
    this.snapshot.updatedAt = time;
    await this.saveSnapshot();

    for (const [socket, session] of this.sessions.entries()) {
      this.send(socket, {
        type: 'rematch_started',
        playerColor: session.color,
        session: this.publicSession(session),
        room: publicSnapshot(this.snapshot),
      });
    }
  }

  async finishGame({ result, reason, by }) {
    this.snapshot.status = 'finished';
    this.snapshot.result = result || null;
    this.snapshot.endReason = reason || 'game_finished';
    this.snapshot.endedAt = nowIso();
    this.snapshot.drawOfferBy = null;
    this.snapshot.rematchOfferBy = null;
    await this.saveSnapshot();
    await this.removeFromLobby();

    const payload = {
      type: 'game_over',
      result: this.snapshot.result,
      reason: this.snapshot.endReason,
      by: by || null,
      room: publicSnapshot(this.snapshot),
    };
    this.broadcast(payload);
    await this.storage.setAlarm(Date.now() + FINISHED_ROOM_TTL_MS);
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
      role: session.role,
      clientId: session.clientId || '',
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
