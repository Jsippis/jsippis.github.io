import { GameRoom, Lobby } from './room.js';

export { GameRoom, Lobby };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = allowedOrigins(env);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(request, env, data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(request, env),
    },
  });
}

function notFound(request, env) {
  return jsonResponse(request, env, { ok: false, error: 'not_found' }, 404);
}

function badRequest(request, env, message) {
  return jsonResponse(request, env, { ok: false, error: 'bad_request', message }, 400);
}

function roomCodeFromPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const code = rest.split('/')[0]?.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getLobbyStub(env) {
  const id = env.LOBBY.idFromName('global');
  return env.LOBBY.get(id);
}

function getRoomStub(env, roomCode) {
  const id = env.GAME_ROOM.idFromName(roomCode);
  return env.GAME_ROOM.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return jsonResponse(request, env, {
        ok: true,
        service: 'chesstein-worker',
        endpoints: {
          createRoom: 'POST /api/rooms',
          listRooms: 'GET /api/rooms',
          roomSnapshot: 'GET /api/rooms/:roomCode',
          websocket: 'GET /ws/rooms/:roomCode',
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      const lobby = getLobbyStub(env);
      const response = await lobby.fetch(new Request('https://lobby/list', { method: 'GET' }));
      const data = await response.json();
      return jsonResponse(request, env, data, response.status);
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await parseJson(request);
      const visibility = body.visibility === 'private' ? 'private' : 'public';
      const roomCode = makeRoomCode();
      const playerToken = crypto.randomUUID();

      const initPayload = {
        roomCode,
        visibility,
        playerToken,
        name: String(body.name || 'Player').slice(0, 32),
        clientType: body.clientType || 'gui',
        role: body.role || body.clientRole || body.playerRole || (body.clientType === 'bridge' ? 'bridge' : 'player'),
        clientId: String(body.clientId || '').slice(0, 80),
        previewVisibility: body.previewVisibility || body.preview || 'private',
        timeControl: body.timeControl || {},
      };

      const room = getRoomStub(env, roomCode);
      const initResponse = await room.fetch(new Request('https://room/init', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(initPayload),
      }));

      if (!initResponse.ok) {
        return jsonResponse(request, env, { ok: false, error: 'room_init_failed' }, 500);
      }

      const initData = await initResponse.json();
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return jsonResponse(request, env, {
        ok: true,
        room: initData.room,
        roomCode,
        playerToken,
        bridgeJoinToken: initPayload.role === 'bridge' ? playerToken : undefined,
        color: 'white',
        roomUrl: `${url.origin}/api/rooms/${roomCode}`,
        wsUrl: `${wsProtocol}//${url.host}/ws/rooms/${roomCode}?token=${encodeURIComponent(playerToken)}&client=${encodeURIComponent(initPayload.clientType === 'bridge' ? 'bridge' : 'gui')}&role=${encodeURIComponent(initPayload.role)}&clientId=${encodeURIComponent(initPayload.clientId)}`,
      }, 201);
    }

    const bridgeTokenRoomCode = roomCodeFromPath(url.pathname, '/api/rooms/');
    if (bridgeTokenRoomCode && request.method === 'POST' && url.pathname.endsWith('/bridge-token')) {
      const room = getRoomStub(env, bridgeTokenRoomCode);
      const body = await parseJson(request);
      const response = await room.fetch(new Request(`https://room/bridge-token?roomCode=${bridgeTokenRoomCode}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }));
      const data = await response.json();
      return jsonResponse(request, env, data, response.status);
    }

    const apiRoomCode = roomCodeFromPath(url.pathname, '/api/rooms/');
    if (apiRoomCode && request.method === 'GET') {
      const room = getRoomStub(env, apiRoomCode);
      const response = await room.fetch(new Request(`https://room/snapshot?roomCode=${apiRoomCode}`, { method: 'GET' }));
      const data = await response.json();
      return jsonResponse(request, env, data, response.status);
    }

    if (apiRoomCode && request.method === 'DELETE') {
      const room = getRoomStub(env, apiRoomCode);
      const token = url.searchParams.get('token') || '';
      const response = await room.fetch(new Request(`https://room/cancel?roomCode=${apiRoomCode}&token=${encodeURIComponent(token)}`, { method: 'DELETE' }));
      const data = await response.json();
      return jsonResponse(request, env, data, response.status);
    }

    const wsRoomCode = roomCodeFromPath(url.pathname, '/ws/rooms/');
    if (wsRoomCode) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return badRequest(request, env, 'Expected WebSocket upgrade request.');
      }

      const room = getRoomStub(env, wsRoomCode);
      return room.fetch(request);
    }

    return notFound(request, env);
  },
};
