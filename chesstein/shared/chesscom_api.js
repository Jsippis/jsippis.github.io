(function () {
  'use strict';

  const API_ROOT = 'https://api.chess.com/pub';

  function cleanUsername(username) {
    return String(username || '').trim().replace(/^@/, '').toLowerCase();
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      const message = response.status === 404
        ? 'Chess.com did not find that public username or archive.'
        : `Chess.com API returned ${response.status}.`;
      throw new Error(message);
    }
    return response.json();
  }

  async function getArchives(username) {
    const clean = cleanUsername(username);
    if (!clean) throw new Error('Enter a Chess.com username first.');
    const data = await fetchJson(`${API_ROOT}/player/${encodeURIComponent(clean)}/games/archives`);
    return Array.isArray(data.archives) ? data.archives : [];
  }

  async function getArchiveGames(archiveUrl) {
    const data = await fetchJson(archiveUrl);
    return Array.isArray(data.games) ? data.games : [];
  }

  async function loadRecentGames(username, options = {}) {
    const months = Math.max(1, Math.min(12, Number(options.months || 3)));
    const archives = await getArchives(username);
    const recentArchives = archives.slice(-months).reverse();
    const batches = [];
    for (const archive of recentArchives) {
      batches.push(await getArchiveGames(archive));
    }
    return batches.flat().sort((a, b) => Number(b.end_time || 0) - Number(a.end_time || 0));
  }

  function playerLabel(player) {
    if (!player) return 'Unknown';
    const username = player.username || player.user_id || 'Unknown';
    const rating = player.rating ? ` (${player.rating})` : '';
    return `${username}${rating}`;
  }

  function gameResultForUsername(game, username) {
    const clean = cleanUsername(username);
    const white = cleanUsername(game?.white?.username || '');
    const black = cleanUsername(game?.black?.username || '');
    if (white !== clean && black !== clean) return game?.result || '';
    const side = white === clean ? 'white' : 'black';
    const result = game?.[side]?.result || '';
    if (result === 'win') return 'Win';
    if (['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(result)) return 'Draw';
    return result ? 'Loss' : '';
  }

  function normalizeGame(game, username = '') {
    return {
      source: 'chesscom',
      url: game.url || '',
      uuid: game.uuid || game.url || '',
      timeClass: game.time_class || '',
      timeControl: game.time_control || '',
      rated: !!game.rated,
      endTime: game.end_time || null,
      white: game.white || {},
      black: game.black || {},
      whiteLabel: playerLabel(game.white),
      blackLabel: playerLabel(game.black),
      userResult: gameResultForUsername(game, username),
      result: game.result || '',
      pgn: game.pgn || '',
      accuracies: game.accuracies || null
    };
  }

  window.ChessteinChessComApi = {
    API_ROOT,
    cleanUsername,
    getArchives,
    getArchiveGames,
    loadRecentGames,
    normalizeGame,
    playerLabel,
    gameResultForUsername
  };
})();
