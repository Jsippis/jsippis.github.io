(function () {
  'use strict';

  const LABELS = {
    best: ['Best', 'BEST'],
    excellent: ['Excellent', 'EXC'],
    good: ['Good', 'GOOD'],
    inaccuracy: ['Inaccuracy', 'INACC'],
    mistake: ['Mistake', 'MIST'],
    blunder: ['Blunder', 'BLUN']
  };

  function scoreToWhitePercent(whiteScore) {
    if (!whiteScore) return 50;
    if (whiteScore.type === 'mate') return whiteScore.mate > 0 ? 100 : 0;
    const cp = Math.max(-900, Math.min(900, Number(whiteScore.cp || 0)));
    return Math.max(2, Math.min(98, 100 / (1 + Math.exp(-cp / 170))));
  }

  function formatWhiteScore(whiteScore) {
    if (!whiteScore) return '—';
    if (whiteScore.type === 'mate') {
      const sign = whiteScore.mate >= 0 ? '+' : '-';
      return `${sign}M${Math.abs(whiteScore.mate)}`;
    }
    const pawns = Number(whiteScore.cp || 0) / 100;
    const sign = pawns >= 0 ? '+' : '';
    return `${sign}${pawns.toFixed(1)}`;
  }

  function expectedPointsForWhite(whiteScore) {
    if (!whiteScore) return 0.5;
    if (whiteScore.type === 'mate') return whiteScore.mate > 0 ? 1 : 0;
    return scoreToWhitePercent(whiteScore) / 100;
  }

  function expectedPointsForColor(whiteScore, color) {
    const whiteEp = expectedPointsForWhite(whiteScore);
    return color === 'black' || color === 'b' ? 1 - whiteEp : whiteEp;
  }

  function normalizeScoreForWhite(score, positionOrTurn) {
    if (!score) return null;
    const turn = typeof positionOrTurn === 'string' ? positionOrTurn : positionOrTurn?.turn;
    const sign = turn === 'w' || turn === 'white' ? 1 : -1;
    if (score.type === 'mate') return { type: 'mate', mate: Number(score.value || 0) * sign };
    return { type: 'cp', cp: Number(score.value || 0) * sign };
  }

  function classifyMove(options = {}) {
    const beforeWhiteScore = options.beforeWhiteScore;
    const afterWhiteScore = options.afterWhiteScore;
    if (!beforeWhiteScore || !afterWhiteScore) return null;

    const mover = options.mover === 'b' ? 'black' : (options.mover || 'white');
    const playedUci = options.playedUci || null;
    const bestUci = options.bestUci || null;
    const bestEp = expectedPointsForColor(beforeWhiteScore, mover);
    const actualEp = expectedPointsForColor(afterWhiteScore, mover);
    const loss = Math.max(0, bestEp - actualEp);
    const playedBest = !!playedUci && !!bestUci && String(playedUci).toLowerCase() === String(bestUci).toLowerCase();

    let key = 'blunder';
    if (playedBest || loss <= 0.005) key = 'best';
    else if (loss <= 0.02) key = 'excellent';
    else if (loss <= 0.05) key = 'good';
    else if (loss <= 0.10) key = 'inaccuracy';
    else if (loss <= 0.20) key = 'mistake';

    const [label, shortLabel] = LABELS[key] || LABELS.good;
    return {
      key,
      label,
      shortLabel,
      loss,
      accuracy: moveAccuracyFromLoss(loss),
      playedUci,
      bestUci,
      title: `${label} · expected-points loss ${loss.toFixed(3)}`
    };
  }

  function moveAccuracyFromLoss(loss) {
    const n = Math.max(0, Number(loss || 0));
    // A simple Chesstein estimate: tiny expected-point losses remain near 100,
    // then severe mistakes fall quickly. This is intentionally not Chess.com's
    // private accuracy formula.
    return Math.max(0, Math.min(100, 100 * Math.exp(-4.25 * n)));
  }

  function averageAccuracy(classifications = [], color = null, moves = []) {
    let total = 0;
    let count = 0;
    classifications.forEach((classification, index) => {
      if (!classification || !Number.isFinite(classification.accuracy)) return;
      if (color) {
        const move = moves[index] || null;
        const moveColor = move?.color || (index % 2 === 0 ? 'white' : 'black');
        if (moveColor !== color && moveColor !== (color === 'white' ? 'w' : 'b')) return;
      }
      total += classification.accuracy;
      count += 1;
    });
    return count ? total / count : null;
  }

  function enrichReviewAnalysis(raw, position, options = {}) {
    const bestUci = raw.bestmove && raw.bestmove !== '(none)' ? raw.bestmove : (raw.pv?.[0] || null);
    const whiteScore = normalizeScoreForWhite(raw.score, position);
    return {
      ...raw,
      ply: options.ply ?? null,
      bestUci,
      whiteScore,
      bestDisplay: bestUci && options.formatBestMove ? options.formatBestMove(bestUci, position) : (bestUci || '—'),
      lineDisplay: raw.pv?.length && options.formatLine ? options.formatLine(raw.pv, position) : (raw.pv?.join(' ') || 'No principal variation.')
    };
  }

  window.ChessteinAnalysis = {
    LABELS,
    scoreToWhitePercent,
    formatWhiteScore,
    expectedPointsForWhite,
    expectedPointsForColor,
    normalizeScoreForWhite,
    classifyMove,
    moveAccuracyFromLoss,
    averageAccuracy,
    enrichReviewAnalysis
  };
})();
