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

function finiteNumber(value, min, max, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return number;
}

function optionalInteger(value, min, max, name) {
  if (value === null || value === undefined || value === '') return null;
  return Math.round(finiteNumber(value, min, max, name));
}

function safeText(value, maxLength, name) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw new Error(`${name} is invalid.`);
  return text;
}

function parseCalibrationSample(body) {
  const features = body?.features || {};
  const sampleId = safeText(body?.sampleId, 64, 'sampleId').toLowerCase();
  const gameHash = safeText(body?.gameHash, 64, 'gameHash').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sampleId) || !/^[a-f0-9]{64}$/.test(gameHash)) {
    throw new Error('Calibration hashes must be SHA-256 hex values.');
  }
  const playerColor = body?.playerColor === 'black' ? 'black' : body?.playerColor === 'white' ? 'white' : null;
  if (!playerColor) throw new Error('playerColor must be white or black.');

  const createdAt = String(body?.createdAt || '');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be an ISO date.');

  return {
    sampleId,
    gameHash,
    playerColor,
    ratingBucket: optionalInteger(body?.ratingBucket, 0, 4000, 'ratingBucket'),
    timeClass: String(body?.timeClass || '').trim().slice(0, 20),
    moveCount: Math.round(finiteNumber(body?.moveCount, 1, 1000, 'moveCount')),
    engineVersion: safeText(body?.engineVersion, 80, 'engineVersion'),
    analysisProfile: safeText(body?.analysisProfile, 80, 'analysisProfile'),
    featureVersion: Math.round(finiteNumber(body?.featureVersion, 1, 1000, 'featureVersion')),
    formulaVersion: safeText(body?.formulaVersion, 80, 'formulaVersion'),
    meanMoveAccuracy: finiteNumber(features.meanMoveAccuracy, 0, 100, 'meanMoveAccuracy'),
    weightedMeanAccuracy: finiteNumber(features.weightedMeanAccuracy, 0, 100, 'weightedMeanAccuracy'),
    geometricMeanAccuracy: finiteNumber(features.geometricMeanAccuracy, 0, 100, 'geometricMeanAccuracy'),
    worstQuartileAccuracy: finiteNumber(features.worstQuartileAccuracy, 0, 100, 'worstQuartileAccuracy'),
    meanExpectedLoss: finiteNumber(features.meanExpectedLoss, 0, 1, 'meanExpectedLoss'),
    totalExpectedLoss: finiteNumber(features.totalExpectedLoss, 0, 1000, 'totalExpectedLoss'),
    worstExpectedLoss: finiteNumber(features.worstExpectedLoss, 0, 1, 'worstExpectedLoss'),
    worstThreeExpectedLoss: finiteNumber(features.worstThreeExpectedLoss, 0, 1, 'worstThreeExpectedLoss'),
    meanScoringLoss: finiteNumber(features.meanScoringLoss ?? 0, 0, 1, 'meanScoringLoss'),
    worstScoringLoss: finiteNumber(features.worstScoringLoss ?? 0, 0, 1, 'worstScoringLoss'),
    meanConversionLoss: finiteNumber(features.meanConversionLoss ?? 0, 0, 1, 'meanConversionLoss'),
    totalConversionLoss: finiteNumber(features.totalConversionLoss ?? 0, 0, 1000, 'totalConversionLoss'),
    bestMoveRate: finiteNumber(features.bestMoveRate, 0, 1, 'bestMoveRate'),
    exactBestMoves: Math.round(finiteNumber(features.exactBestMoves ?? 0, 0, 1000, 'exactBestMoves')),
    inaccuracies: Math.round(finiteNumber(features.inaccuracies, 0, 1000, 'inaccuracies')),
    mistakes: Math.round(finiteNumber(features.mistakes, 0, 1000, 'mistakes')),
    blunders: Math.round(finiteNumber(features.blunders, 0, 1000, 'blunders')),
    decisiveErrors: Math.round(finiteNumber(features.decisiveErrors, 0, 1000, 'decisiveErrors')),
    mateTransitions: Math.round(finiteNumber(features.mateTransitions, 0, 1000, 'mateTransitions')),
    slowerMateMoves: Math.round(finiteNumber(features.slowerMateMoves ?? 0, 0, 1000, 'slowerMateMoves')),
    totalMateDelay: Math.round(finiteNumber(features.totalMateDelay ?? 0, 0, 10000, 'totalMateDelay')),
    missedForcedMates: Math.round(finiteNumber(features.missedForcedMates ?? 0, 0, 1000, 'missedForcedMates')),
    forcedMoves: Math.round(finiteNumber(features.forcedMoves, 0, 1000, 'forcedMoves')),
    settledMoves: Math.round(finiteNumber(features.settledMoves, 0, 1000, 'settledMoves')),
    settledWinningMoves: Math.round(finiteNumber(features.settledWinningMoves ?? 0, 0, 1000, 'settledWinningMoves')),
    settledLosingMoves: Math.round(finiteNumber(features.settledLosingMoves ?? 0, 0, 1000, 'settledLosingMoves')),
    nonBestWinningMoves: Math.round(finiteNumber(features.nonBestWinningMoves ?? 0, 0, 1000, 'nonBestWinningMoves')),
    conversionMoves: Math.round(finiteNumber(features.conversionMoves ?? 0, 0, 1000, 'conversionMoves')),
    meaningfulMoves: Math.round(finiteNumber(features.meaningfulMoves, 0, 1000, 'meaningfulMoves')),
    chesscomAccuracy: finiteNumber(body?.chesscomAccuracy, 0, 100, 'chesscomAccuracy'),
    chessteinAccuracy: finiteNumber(body?.chessteinAccuracy, 0, 100, 'chessteinAccuracy'),
    createdAt: new Date(createdAt).toISOString(),
  };
}

async function storeCalibrationSample(env, sample) {
  if (!env.CALIBRATION_DB) throw new Error('Calibration database binding is not configured.');
  return env.CALIBRATION_DB.prepare(`
    INSERT OR IGNORE INTO calibration_samples (
      sample_id, game_hash, player_color, rating_bucket, time_class, move_count,
      engine_version, analysis_profile, feature_version, formula_version,
      mean_move_accuracy, weighted_mean_accuracy, geometric_mean_accuracy,
      worst_quartile_accuracy, mean_expected_loss, total_expected_loss,
      worst_expected_loss, worst_three_expected_loss,
      mean_scoring_loss, worst_scoring_loss, mean_conversion_loss, total_conversion_loss,
      best_move_rate, exact_best_moves,
      inaccuracies, mistakes, blunders, decisive_errors, mate_transitions,
      slower_mate_moves, total_mate_delay, missed_forced_mates,
      forced_moves, settled_moves, settled_winning_moves, settled_losing_moves,
      non_best_winning_moves, conversion_moves, meaningful_moves,
      chesscom_accuracy, chesstein_accuracy, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    sample.sampleId, sample.gameHash, sample.playerColor, sample.ratingBucket,
    sample.timeClass, sample.moveCount, sample.engineVersion, sample.analysisProfile,
    sample.featureVersion, sample.formulaVersion, sample.meanMoveAccuracy,
    sample.weightedMeanAccuracy, sample.geometricMeanAccuracy, sample.worstQuartileAccuracy,
    sample.meanExpectedLoss, sample.totalExpectedLoss, sample.worstExpectedLoss,
    sample.worstThreeExpectedLoss, sample.meanScoringLoss, sample.worstScoringLoss,
    sample.meanConversionLoss, sample.totalConversionLoss, sample.bestMoveRate,
    sample.exactBestMoves, sample.inaccuracies, sample.mistakes, sample.blunders,
    sample.decisiveErrors, sample.mateTransitions, sample.slowerMateMoves,
    sample.totalMateDelay, sample.missedForcedMates, sample.forcedMoves,
    sample.settledMoves, sample.settledWinningMoves, sample.settledLosingMoves,
    sample.nonBestWinningMoves, sample.conversionMoves, sample.meaningfulMoves,
    sample.chesscomAccuracy, sample.chessteinAccuracy, sample.createdAt
  ).run();
}

async function validateLobbyRooms(env, rooms) {
  const lobby = getLobbyStub(env);
  const visible = [];

  for (const room of Array.isArray(rooms) ? rooms : []) {
    const roomCode = roomCodeFromPath(`/api/rooms/${room?.roomCode || ''}`, '/api/rooms/');
    if (!roomCode) continue;

    try {
      const roomStub = getRoomStub(env, roomCode);
      const response = await roomStub.fetch(new Request(`https://room/lobby-summary?roomCode=${roomCode}`, { method: 'GET' }));
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok && data.room) {
        visible.push(data.room);
      } else {
        await lobby.fetch(new Request(`https://lobby/rooms/${roomCode}`, { method: 'DELETE' }));
      }
    } catch {
      await lobby.fetch(new Request(`https://lobby/rooms/${roomCode}`, { method: 'DELETE' })).catch(() => {});
    }
  }

  return visible;
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
          calibration: 'POST /api/calibration',
          calibrationStats: 'GET /api/calibration/stats',
        },
      });
    }


    if (request.method === 'POST' && url.pathname === '/api/calibration') {
      if (!env.CALIBRATION_DB) {
        return jsonResponse(request, env, { ok: false, error: 'calibration_not_configured' }, 503);
      }
      const contentLength = Number(request.headers.get('content-length') || 0);
      if (contentLength > 32_000) return badRequest(request, env, 'Calibration payload is too large.');
      let sample;
      try {
        sample = parseCalibrationSample(await parseJson(request));
      } catch (error) {
        return badRequest(request, env, error?.message || 'Invalid calibration sample.');
      }
      try {
        const result = await storeCalibrationSample(env, sample);
        return jsonResponse(request, env, {
          ok: true,
          sampleId: sample.sampleId,
          inserted: Number(result?.meta?.changes || 0) > 0,
        }, 202);
      } catch (error) {
        return jsonResponse(request, env, {
          ok: false,
          error: 'calibration_store_failed',
          message: error?.message || 'Could not store calibration sample.',
        }, 500);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/calibration/stats') {
      if (!env.CALIBRATION_DB) {
        return jsonResponse(request, env, { ok: false, error: 'calibration_not_configured' }, 503);
      }
      const totals = await env.CALIBRATION_DB.prepare(`
        SELECT COUNT(*) AS samples,
               COUNT(DISTINCT game_hash) AS games,
               AVG(ABS(chesscom_accuracy - chesstein_accuracy)) AS mean_absolute_error
        FROM calibration_samples
      `).first();
      return jsonResponse(request, env, {
        ok: true,
        samples: Number(totals?.samples || 0),
        games: Number(totals?.games || 0),
        meanAbsoluteError: totals?.mean_absolute_error === null || totals?.mean_absolute_error === undefined
          ? null
          : Number(totals.mean_absolute_error),
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/rooms') {
      const lobby = getLobbyStub(env);
      const response = await lobby.fetch(new Request('https://lobby/list', { method: 'GET' }));
      const data = await response.json();
      if (!response.ok || !data.ok) return jsonResponse(request, env, data, response.status);
      const rooms = await validateLobbyRooms(env, data.rooms || []);
      return jsonResponse(request, env, { ok: true, rooms }, response.status);
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
