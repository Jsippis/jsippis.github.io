(function () {
  'use strict';

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const PIECE_FROM_FEN = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };

  function idxToAlg(idx) {
    const file = String.fromCharCode(97 + (idx % 8));
    const rank = Math.floor(idx / 8) + 1;
    return file + rank;
  }

  function algToIdx(alg) {
    if (!/^[a-h][1-8]$/.test(String(alg || ''))) return -1;
    const file = alg.charCodeAt(0) - 97;
    const rank = parseInt(alg[1], 10) - 1;
    return rank * 8 + file;
  }

  function rankOf(idx) { return Math.floor(idx / 8); }
  function fileOf(idx) { return idx % 8; }
  function onBoard(rank, file) { return rank >= 0 && rank < 8 && file >= 0 && file < 8; }
  function otherSide(color) { return color === 'w' ? 'b' : 'w'; }
  function pieceColor(piece) { return piece ? piece[0] : null; }

  function fenToPosition(fen = START_FEN) {
    const parts = String(fen || START_FEN).trim().split(/\s+/);
    const boardPart = parts[0] || START_FEN.split(' ')[0];
    const board = Array(64).fill(null);
    const rows = boardPart.split('/');
    for (let r = 0; r < 8; r++) {
      const rank = 7 - r;
      let file = 0;
      for (const ch of rows[r] || '') {
        if (/\d/.test(ch)) {
          file += Number(ch);
        } else {
          const color = ch === ch.toUpperCase() ? 'w' : 'b';
          const type = PIECE_FROM_FEN[ch.toLowerCase()] || ch.toUpperCase();
          board[rank * 8 + file] = color + type;
          file += 1;
        }
      }
    }
    const position = {
      board,
      turn: parts[1] === 'b' ? 'b' : 'w',
      castling: parts[2] && parts[2] !== '-' ? parts[2] : '-',
      enPassant: parts[3] || '-',
      halfmove: Number(parts[4] || 0),
      fullmove: Number(parts[5] || 1),
      fen: '',
      lastMove: null
    };
    position.fen = positionToFen(position);
    return position;
  }

  function positionToFen(position) {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = '';
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = position.board[rank * 8 + file];
        if (!piece) {
          empty += 1;
          continue;
        }
        if (empty) { row += String(empty); empty = 0; }
        row += piece[0] === 'w' ? piece[1] : piece[1].toLowerCase();
      }
      if (empty) row += String(empty);
      rows.push(row);
    }
    return `${rows.join('/')} ${position.turn} ${position.castling || '-'} ${position.enPassant || '-'} ${position.halfmove || 0} ${position.fullmove || 1}`;
  }

  function clonePosition(position) {
    return {
      board: position.board.slice(),
      turn: position.turn,
      castling: position.castling || '-',
      enPassant: position.enPassant || '-',
      halfmove: Number(position.halfmove || 0),
      fullmove: Number(position.fullmove || 1),
      fen: position.fen || positionToFen(position),
      lastMove: position.lastMove ? position.lastMove.slice() : null
    };
  }

  function findKing(board, color) {
    return board.findIndex(piece => piece === color + 'K');
  }

  function isSquareAttacked(board, square, byColor) {
    const rank = rankOf(square);
    const file = fileOf(square);
    const pawnDir = byColor === 'w' ? 1 : -1;

    for (const df of [-1, 1]) {
      const r = rank - pawnDir;
      const f = file - df;
      if (onBoard(r, f) && board[r * 8 + f] === byColor + 'P') return true;
    }

    for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const r = rank + dr;
      const f = file + df;
      if (onBoard(r, f) && board[r * 8 + f] === byColor + 'N') return true;
    }

    for (const [dr, df, sliders] of [
      [-1,-1, ['B','Q']], [-1,1, ['B','Q']], [1,-1, ['B','Q']], [1,1, ['B','Q']],
      [-1,0, ['R','Q']], [1,0, ['R','Q']], [0,-1, ['R','Q']], [0,1, ['R','Q']]
    ]) {
      let r = rank + dr;
      let f = file + df;
      while (onBoard(r, f)) {
        const piece = board[r * 8 + f];
        if (piece) {
          if (piece[0] === byColor && sliders.includes(piece[1])) return true;
          break;
        }
        r += dr;
        f += df;
      }
    }

    for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
      const r = rank + dr;
      const f = file + df;
      if (onBoard(r, f) && board[r * 8 + f] === byColor + 'K') return true;
    }
    return false;
  }

  function isKingInCheck(board, color) {
    const king = findKing(board, color);
    if (king < 0) return true;
    return isSquareAttacked(board, king, otherSide(color));
  }

  function isPromotion(piece, to) {
    if (!piece || piece[1] !== 'P') return false;
    const rank = rankOf(to);
    return (piece[0] === 'w' && rank === 7) || (piece[0] === 'b' && rank === 0);
  }

  function pushPawnMove(moves, from, to, piece, capture = false) {
    if (isPromotion(piece, to)) {
      for (const promotion of ['q', 'r', 'b', 'n']) moves.push({ from, to, promotion, capture });
    } else {
      moves.push({ from, to, promotion: null, capture });
    }
  }

  function pseudoLegalMovesFor(position, idx) {
    const board = position.board;
    const moves = [];
    const piece = board[idx];
    if (!piece) return moves;

    const color = piece[0];
    const type = piece[1];
    const rank = rankOf(idx);
    const file = fileOf(idx);

    function tryAdd(to) {
      if (to < 0 || to > 63) return false;
      const target = board[to];
      if (target && target[0] === color) return false;
      if (target && target[1] === 'K') return false;
      moves.push({ from: idx, to, promotion: null, capture: !!target });
      return !target;
    }

    function slide(dr, df) {
      let r = rank + dr;
      let f = file + df;
      while (onBoard(r, f)) {
        if (!tryAdd(r * 8 + f)) break;
        r += dr;
        f += df;
      }
    }

    if (type === 'P') {
      const dir = color === 'w' ? 1 : -1;
      const startRank = color === 'w' ? 1 : 6;
      const fwd = idx + dir * 8;
      if (fwd >= 0 && fwd < 64 && !board[fwd]) {
        pushPawnMove(moves, idx, fwd, piece, false);
        if (rank === startRank) {
          const fwd2 = fwd + dir * 8;
          if (fwd2 >= 0 && fwd2 < 64 && !board[fwd2]) moves.push({ from: idx, to: fwd2, promotion: null, capture: false });
        }
      }
      for (const df of [-1, 1]) {
        const r = rank + dir;
        const f = file + df;
        if (!onBoard(r, f)) continue;
        const to = r * 8 + f;
        const target = board[to];
        const epCapture = idxToAlg(to) === position.enPassant;
        if ((target && target[0] !== color && target[1] !== 'K') || epCapture) {
          pushPawnMove(moves, idx, to, piece, true);
        }
      }
    }

    if (type === 'N') {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const r = rank + dr;
        const f = file + df;
        if (onBoard(r, f)) tryAdd(r * 8 + f);
      }
    }

    if (type === 'B' || type === 'Q') {
      for (const [dr, df] of [[-1,-1],[-1,1],[1,-1],[1,1]]) slide(dr, df);
    }

    if (type === 'R' || type === 'Q') {
      for (const [dr, df] of [[-1,0],[1,0],[0,-1],[0,1]]) slide(dr, df);
    }

    if (type === 'K') {
      for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
        const r = rank + dr;
        const f = file + df;
        if (onBoard(r, f)) tryAdd(r * 8 + f);
      }

      const enemy = otherSide(color);
      if (!isKingInCheck(board, color)) {
        if (color === 'w' && idx === 4) {
          if ((position.castling || '').includes('K') && !board[5] && !board[6] && board[7] === 'wR' && !isSquareAttacked(board, 5, enemy) && !isSquareAttacked(board, 6, enemy)) {
            moves.push({ from: 4, to: 6, promotion: null, capture: false, castle: 'K' });
          }
          if ((position.castling || '').includes('Q') && !board[3] && !board[2] && !board[1] && board[0] === 'wR' && !isSquareAttacked(board, 3, enemy) && !isSquareAttacked(board, 2, enemy)) {
            moves.push({ from: 4, to: 2, promotion: null, capture: false, castle: 'Q' });
          }
        }
        if (color === 'b' && idx === 60) {
          if ((position.castling || '').includes('k') && !board[61] && !board[62] && board[63] === 'bR' && !isSquareAttacked(board, 61, enemy) && !isSquareAttacked(board, 62, enemy)) {
            moves.push({ from: 60, to: 62, promotion: null, capture: false, castle: 'k' });
          }
          if ((position.castling || '').includes('q') && !board[59] && !board[58] && !board[57] && board[56] === 'bR' && !isSquareAttacked(board, 59, enemy) && !isSquareAttacked(board, 58, enemy)) {
            moves.push({ from: 60, to: 58, promotion: null, capture: false, castle: 'q' });
          }
        }
      }
    }

    return moves;
  }

  function applyMove(position, move) {
    const nextBoard = position.board.slice();
    const piece = nextBoard[move.from];
    if (!piece) throw new Error(`No piece on ${idxToAlg(move.from)}.`);
    const color = piece[0];
    const type = piece[1];
    let captured = nextBoard[move.to];
    let castling = position.castling || '-';
    let enPassant = '-';
    let halfmove = Number(position.halfmove || 0) + 1;
    let fullmove = Number(position.fullmove || 1);
    const fromAlg = idxToAlg(move.from);
    const toAlg = idxToAlg(move.to);

    if (type === 'P' && toAlg === position.enPassant && !captured && fileOf(move.from) !== fileOf(move.to)) {
      const capturedIdx = move.to + (color === 'w' ? -8 : 8);
      captured = nextBoard[capturedIdx];
      nextBoard[capturedIdx] = null;
    }

    nextBoard[move.to] = move.promotion ? color + String(move.promotion).toUpperCase() : piece;
    nextBoard[move.from] = null;

    if (type === 'K' && Math.abs(move.to - move.from) === 2) {
      if (move.to > move.from) {
        nextBoard[move.from + 1] = nextBoard[move.from + 3];
        nextBoard[move.from + 3] = null;
      } else {
        nextBoard[move.from - 1] = nextBoard[move.from - 4];
        nextBoard[move.from - 4] = null;
      }
    }

    if (type === 'K') castling = color === 'w' ? castling.replace(/[KQ]/g, '') : castling.replace(/[kq]/g, '');
    if (type === 'R') {
      if (fromAlg === 'a1') castling = castling.replace('Q', '');
      if (fromAlg === 'h1') castling = castling.replace('K', '');
      if (fromAlg === 'a8') castling = castling.replace('q', '');
      if (fromAlg === 'h8') castling = castling.replace('k', '');
    }
    if (captured) {
      if (toAlg === 'a1') castling = castling.replace('Q', '');
      if (toAlg === 'h1') castling = castling.replace('K', '');
      if (toAlg === 'a8') castling = castling.replace('q', '');
      if (toAlg === 'h8') castling = castling.replace('k', '');
    }
    if (!castling) castling = '-';

    if (type === 'P') {
      halfmove = 0;
      if (Math.abs(move.to - move.from) === 16) enPassant = idxToAlg((move.from + move.to) / 2);
    } else if (captured) {
      halfmove = 0;
    }
    if (color === 'b') fullmove += 1;

    const next = {
      board: nextBoard,
      turn: otherSide(position.turn),
      castling,
      enPassant,
      halfmove,
      fullmove,
      fen: '',
      lastMove: [move.from, move.to]
    };
    next.fen = positionToFen(next);
    return { position: next, piece, captured };
  }

  function legalMoves(position) {
    const moves = [];
    for (let idx = 0; idx < 64; idx++) {
      const piece = position.board[idx];
      if (!piece || piece[0] !== position.turn) continue;
      for (const move of pseudoLegalMovesFor(position, idx)) {
        const result = applyMove(position, move);
        if (!isKingInCheck(result.position.board, piece[0])) moves.push(move);
      }
    }
    return moves;
  }

  function cleanSan(san) {
    return String(san || '')
      .trim()
      .replace(/[!?]+$/g, '')
      .replace(/[+#]+$/g, '')
      .replace(/\s*e\.p\.?$/i, '')
      .replace(/^0-0/i, 'O-O')
      .replace(/×/g, 'x');
  }

  function sanDescriptor(san) {
    const clean = cleanSan(san);
    if (/^O-O-O$/i.test(clean)) return { castle: 'queen' };
    if (/^O-O$/i.test(clean)) return { castle: 'king' };

    const promotionMatch = clean.match(/=([QRBN])$/i);
    const promotion = promotionMatch ? promotionMatch[1].toLowerCase() : null;
    const withoutPromotion = clean.replace(/=([QRBN])$/i, '');
    const destinationMatch = withoutPromotion.match(/([a-h][1-8])$/);
    if (!destinationMatch) return null;

    const to = algToIdx(destinationMatch[1]);
    const prefix = withoutPromotion.slice(0, withoutPromotion.length - 2);
    const pieceMatch = prefix.match(/^([KQRBN])/);
    const piece = pieceMatch ? pieceMatch[1] : 'P';
    let disambiguation = pieceMatch ? prefix.slice(1) : prefix;
    const isCapture = disambiguation.includes('x');
    disambiguation = disambiguation.replace('x', '');

    return { piece, to, promotion, isCapture, disambiguation };
  }

  function moveMatchesSan(move, position, descriptor) {
    const piece = position.board[move.from];
    if (!piece) return false;

    if (descriptor.castle) {
      if (piece[1] !== 'K') return false;
      return descriptor.castle === 'king' ? move.to > move.from && Math.abs(move.to - move.from) === 2 : move.to < move.from && Math.abs(move.to - move.from) === 2;
    }

    if (piece[1] !== descriptor.piece) return false;
    if (move.to !== descriptor.to) return false;
    if ((move.promotion || null) !== (descriptor.promotion || null)) return false;

    const fromAlg = idxToAlg(move.from);
    const dis = descriptor.disambiguation || '';
    if (dis.length === 2 && fromAlg !== dis) return false;
    if (dis.length === 1 && /[a-h]/.test(dis) && fromAlg[0] !== dis) return false;
    if (dis.length === 1 && /[1-8]/.test(dis) && fromAlg[1] !== dis) return false;
    return true;
  }

  function stripPgnForTokens(pgn) {
    let text = String(pgn || '');
    text = text.replace(/\r/g, '\n');
    text = text.replace(/^\s*\[[^\n]*\]\s*$/gm, ' ');
    text = text.replace(/;[^\n]*/g, ' ');
    text = text.replace(/\{[^}]*\}/g, ' ');
    // Remove recursive parenthesized variations.
    let previous = '';
    while (previous !== text) {
      previous = text;
      text = text.replace(/\([^()]*\)/g, ' ');
    }
    text = text.replace(/\$\d+/g, ' ');
    text = text.replace(/\d+\.(\.\.)?/g, ' ');
    return text.split(/\s+/).map(t => t.trim()).filter(Boolean).filter(t => !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  }

  function parsePgnTags(pgn) {
    const tags = {};
    const re = /^\s*\[([A-Za-z0-9_]+)\s+"((?:\\"|[^"])*)"\]\s*$/gm;
    let match;
    while ((match = re.exec(String(pgn || '')))) {
      tags[match[1]] = match[2].replace(/\\"/g, '"');
    }
    return tags;
  }

  function parsePgn(pgn) {
    const tags = parsePgnTags(pgn);
    const startFen = tags.SetUp === '1' && tags.FEN ? tags.FEN : START_FEN;
    let position = fenToPosition(startFen);
    const positions = [clonePosition(position)];
    const moves = [];
    const tokens = stripPgnForTokens(pgn);
    const warnings = [];

    tokens.forEach((token, tokenIndex) => {
      const before = clonePosition(position);
      const descriptor = sanDescriptor(token);
      if (!descriptor) {
        warnings.push(`Skipped unknown PGN token ${token}.`);
        return;
      }
      const candidates = legalMoves(position).filter(move => moveMatchesSan(move, position, descriptor));
      if (candidates.length !== 1) {
        const detail = candidates.length ? `${candidates.length} legal candidates` : 'no legal candidates';
        throw new Error(`Could not parse move ${tokenIndex + 1} (${token}): ${detail}.`);
      }
      const move = candidates[0];
      const uci = idxToAlg(move.from) + idxToAlg(move.to) + (move.promotion || '');
      const result = applyMove(position, move);
      position = result.position;
      moves.push({
        ply: moves.length + 1,
        color: before.turn === 'w' ? 'white' : 'black',
        san: token,
        uci,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        fenBefore: before.fen,
        fenAfter: position.fen
      });
      positions.push(clonePosition(position));
    });

    return { tags, positions, moves, warnings, startFen, result: tags.Result || '*' };
  }

  function formatUciMoveForPosition(uci, position) {
    if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(String(uci))) return uci || '';
    const from = algToIdx(uci.slice(0, 2));
    const to = algToIdx(uci.slice(2, 4));
    const promotion = uci.length === 5 ? uci[4].toUpperCase() : '';
    const piece = position.board[from];
    if (!piece) return uci;
    const type = piece[1];
    const toAlg = idxToAlg(to);
    const fromAlg = idxToAlg(from);
    if (type === 'K' && Math.abs(to - from) === 2) return to > from ? 'O-O' : 'O-O-O';
    const capture = !!position.board[to] || (type === 'P' && position.enPassant === toAlg && fromAlg[0] !== toAlg[0]);
    if (type === 'P') return `${capture ? `${fromAlg[0]}x` : ''}${toAlg}${promotion ? `=${promotion}` : ''}`;
    return `${type}${capture ? 'x' : ''}${toAlg}`;
  }

  function formatEngineLine(pv, startPosition, maxMoves = 7) {
    let position = clonePosition(startPosition);
    const labels = [];
    for (const uci of (pv || []).slice(0, maxMoves)) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) continue;
      const move = {
        from: algToIdx(uci.slice(0, 2)),
        to: algToIdx(uci.slice(2, 4)),
        promotion: uci.length === 5 ? uci[4] : null
      };
      if (!position.board[move.from]) break;
      labels.push(formatUciMoveForPosition(uci, position));
      try {
        position = applyMove(position, move).position;
      } catch (_) {
        break;
      }
    }
    return labels.join(' ');
  }

  function gameTitleFromTags(tags = {}) {
    const white = tags.White || 'White';
    const black = tags.Black || 'Black';
    const result = tags.Result || '*';
    return `${white} vs ${black} ${result}`;
  }

  window.ChessteinPgn = {
    START_FEN,
    idxToAlg,
    algToIdx,
    fenToPosition,
    positionToFen,
    clonePosition,
    legalMoves,
    applyMove,
    parsePgn,
    parsePgnTags,
    formatUciMoveForPosition,
    formatEngineLine,
    gameTitleFromTags
  };
})();
