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

  const ANALYSIS_FORMULA_VERSION = 'same-root-wdl-v3';
  const ANALYSIS_FEATURE_VERSION = 3;

  function validWdl(wdl) {
    if (!wdl) return false;
    const win = Number(wdl.win);
    const draw = Number(wdl.draw);
    const loss = Number(wdl.loss);
    return Number.isFinite(win) && Number.isFinite(draw) && Number.isFinite(loss) && win + draw + loss > 0;
  }

  function normalizeWdlForWhite(wdl, positionOrTurn) {
    if (!validWdl(wdl)) return null;
    const turn = typeof positionOrTurn === 'string' ? positionOrTurn : positionOrTurn?.turn;
    const normalized = {
      win: Number(wdl.win),
      draw: Number(wdl.draw),
      loss: Number(wdl.loss)
    };
    if (turn === 'b' || turn === 'black') {
      return { win: normalized.loss, draw: normalized.draw, loss: normalized.win };
    }
    return normalized;
  }

  function expectedPointsFromWhiteWdl(whiteWdl) {
    if (!validWdl(whiteWdl)) return null;
    const total = Number(whiteWdl.win) + Number(whiteWdl.draw) + Number(whiteWdl.loss);
    return (Number(whiteWdl.win) + 0.5 * Number(whiteWdl.draw)) / total;
  }

  function scoreToWhitePercent(whiteScore, whiteWdl = null) {
    const wdlExpected = expectedPointsFromWhiteWdl(whiteWdl);
    if (wdlExpected !== null) return Math.max(0, Math.min(100, wdlExpected * 100));
    if (!whiteScore) return 50;
    if (whiteScore.type === 'mate') return whiteScore.mate > 0 ? 100 : 0;
    const cp = Math.max(-1200, Math.min(1200, Number(whiteScore.cp || 0)));
    return Math.max(1, Math.min(99, 100 / (1 + Math.exp(-cp / 300))));
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

  function expectedPointsForWhite(whiteScore, whiteWdl = null) {
    const wdlExpected = expectedPointsFromWhiteWdl(whiteWdl);
    if (wdlExpected !== null) return wdlExpected;
    if (!whiteScore) return 0.5;
    if (whiteScore.type === 'mate') return whiteScore.mate > 0 ? 1 : 0;
    return scoreToWhitePercent(whiteScore) / 100;
  }

  function expectedPointsForColor(whiteScore, color, whiteWdl = null) {
    const whiteEp = expectedPointsForWhite(whiteScore, whiteWdl);
    return color === 'black' || color === 'b' ? 1 - whiteEp : whiteEp;
  }

  function normalizeScoreForWhite(score, positionOrTurn) {
    if (!score) return null;
    const turn = typeof positionOrTurn === 'string' ? positionOrTurn : positionOrTurn?.turn;
    const sign = turn === 'w' || turn === 'white' ? 1 : -1;
    if (score.type === 'mate') return { type: 'mate', mate: Number(score.value || 0) * sign };
    return { type: 'cp', cp: Number(score.value || 0) * sign };
  }

  function mateAgainstColor(whiteScore, color) {
    if (!whiteScore || whiteScore.type !== 'mate') return false;
    const whiteIsMated = Number(whiteScore.mate || 0) < 0;
    return color === 'black' || color === 'b' ? !whiteIsMated : whiteIsMated;
  }

  function moveAccuracyFromLoss(loss) {
    const n = Math.max(0, Number(loss || 0));
    if (n <= 0.003) return 100;
    const score = 100 / (1 + Math.pow(n / 0.145, 1.72));
    return Math.max(0, Math.min(100, score));
  }

  function classifyMove(options = {}) {
    const bestWhiteScore = options.bestWhiteScore || options.beforeWhiteScore;
    const playedWhiteScore = options.playedWhiteScore || options.afterWhiteScore;
    if (!bestWhiteScore || !playedWhiteScore) return null;

    const mover = options.mover === 'b' ? 'black' : (options.mover || 'white');
    const playedUci = options.playedUci || null;
    const bestUci = options.bestUci || null;
    const bestWhiteWdl = options.bestWhiteWdl || null;
    const playedWhiteWdl = options.playedWhiteWdl || null;
    const bestEp = expectedPointsForColor(bestWhiteScore, mover, bestWhiteWdl);
    const actualEp = expectedPointsForColor(playedWhiteScore, mover, playedWhiteWdl);
    const loss = Math.max(0, bestEp - actualEp);
    const playedBest = !!playedUci && !!bestUci && String(playedUci).toLowerCase() === String(bestUci).toLowerCase();
    const legalMoveCount = Number.isFinite(Number(options.legalMoveCount)) ? Number(options.legalMoveCount) : null;
    const forced = legalMoveCount !== null && legalMoveCount <= 1;
    const settledBefore = bestEp <= 0.025 || bestEp >= 0.975;
    const mateTransition = !mateAgainstColor(bestWhiteScore, mover) && mateAgainstColor(playedWhiteScore, mover);
    const decisiveError = mateTransition || loss >= 0.30 || (bestEp >= 0.20 && actualEp <= 0.02);

    let key = 'blunder';
    if (playedBest || loss <= 0.005) key = 'best';
    else if (loss <= 0.02) key = 'excellent';
    else if (loss <= 0.05) key = 'good';
    else if (loss <= 0.10) key = 'inaccuracy';
    else if (loss <= 0.20) key = 'mistake';

    let accuracy = moveAccuracyFromLoss(loss);
    if (mateTransition) accuracy = Math.min(accuracy, 8);

    let decisionWeight = 1;
    if (forced) decisionWeight = 0.15;
    else if (settledBefore) decisionWeight = 0.25;
    if (decisiveError) decisionWeight = Math.max(decisionWeight, mateTransition ? 1.8 : 1.5);

    const [label, shortLabel] = LABELS[key] || LABELS.good;
    return {
      key,
      label,
      shortLabel,
      loss,
      accuracy,
      playedUci,
      bestUci,
      bestExpectedPoints: bestEp,
      playedExpectedPoints: actualEp,
      legalMoveCount,
      forced,
      settledBefore,
      mateTransition,
      decisiveError,
      decisionWeight,
      meaningful: decisionWeight >= 0.5,
      title: `${label} · expected-points loss ${loss.toFixed(3)}${mateTransition ? ' · allowed forced mate' : ''}`
    };
  }

  function entriesForColor(classifications = [], color = null, moves = []) {
    const wanted = color === 'black' || color === 'b' ? 'black' : color === 'white' || color === 'w' ? 'white' : null;
    const entries = [];
    classifications.forEach((classification, index) => {
      if (!classification || !Number.isFinite(classification.accuracy)) return;
      const move = moves[index] || null;
      const moveColor = move?.color || (index % 2 === 0 ? 'white' : 'black');
      if (wanted && moveColor !== wanted && moveColor !== (wanted === 'white' ? 'w' : 'b')) return;
      entries.push({ classification, move, index });
    });
    return entries;
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function summarizeAccuracy(classifications = [], color = null, moves = []) {
    const entries = entriesForColor(classifications, color, moves);
    if (!entries.length) return null;

    let weightedTotal = 0;
    let weightTotal = 0;
    let logTotal = 0;
    const accuracies = [];
    const losses = [];
    const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    let decisiveErrors = 0;
    let mateTransitions = 0;
    let forcedMoves = 0;
    let settledMoves = 0;
    let meaningfulMoves = 0;

    for (const { classification } of entries) {
      const accuracy = Math.max(0, Math.min(100, Number(classification.accuracy)));
      const weight = Math.max(0.05, Number(classification.decisionWeight || 1));
      weightedTotal += accuracy * weight;
      weightTotal += weight;
      logTotal += Math.log(Math.max(0.01, accuracy / 100)) * weight;
      accuracies.push(accuracy);
      losses.push(Math.max(0, Number(classification.loss || 0)));
      if (counts[classification.key] !== undefined) counts[classification.key] += 1;
      if (classification.decisiveError) decisiveErrors += 1;
      if (classification.mateTransition) mateTransitions += 1;
      if (classification.forced) forcedMoves += 1;
      if (classification.settledBefore) settledMoves += 1;
      if (classification.meaningful) meaningfulMoves += 1;
    }

    const weightedMean = weightTotal ? weightedTotal / weightTotal : mean(accuracies);
    const geometricMean = weightTotal ? Math.exp(logTotal / weightTotal) * 100 : mean(accuracies);
    const meaningfulAccuracies = entries
      .filter(({ classification }) => classification.meaningful)
      .map(({ classification }) => Number(classification.accuracy));
    const sorted = (meaningfulAccuracies.length ? meaningfulAccuracies : accuracies).slice().sort((a, b) => a - b);
    const worstCount = Math.max(1, Math.ceil(sorted.length * 0.25));
    const worstQuartileAccuracy = mean(sorted.slice(0, worstCount));
    const accuracy = Math.max(0, Math.min(100,
      0.75 * weightedMean + 0.15 * geometricMean + 0.10 * worstQuartileAccuracy
    ));

    const sortedLosses = losses.slice().sort((a, b) => b - a);
    return {
      accuracy,
      weightedMeanAccuracy: weightedMean,
      geometricMeanAccuracy: geometricMean,
      worstQuartileAccuracy,
      meanMoveAccuracy: mean(accuracies),
      meanExpectedLoss: mean(losses),
      totalExpectedLoss: losses.reduce((sum, value) => sum + value, 0),
      worstExpectedLoss: sortedLosses[0] || 0,
      worstThreeExpectedLoss: mean(sortedLosses.slice(0, 3)) || 0,
      bestMoveRate: entries.length ? counts.best / entries.length : 0,
      moveCount: entries.length,
      meaningfulMoves,
      forcedMoves,
      settledMoves,
      decisiveErrors,
      mateTransitions,
      counts
    };
  }

  function averageAccuracy(classifications = [], color = null, moves = []) {
    return summarizeAccuracy(classifications, color, moves)?.accuracy ?? null;
  }

  function enrichReviewAnalysis(raw, position, options = {}) {
    const bestUci = raw.bestmove && raw.bestmove !== '(none)' ? raw.bestmove : (raw.pv?.[0] || null);
    const whiteScore = normalizeScoreForWhite(raw.score, position);
    const whiteWdl = normalizeWdlForWhite(raw.wdl, position);
    return {
      ...raw,
      ply: options.ply ?? null,
      bestUci,
      whiteScore,
      whiteWdl,
      expectedWhite: expectedPointsForWhite(whiteScore, whiteWdl),
      bestDisplay: bestUci && options.formatBestMove ? options.formatBestMove(bestUci, position) : (bestUci || '—'),
      lineDisplay: raw.pv?.length && options.formatLine ? options.formatLine(raw.pv, position) : (raw.pv?.join(' ') || 'No principal variation.')
    };
  }

  window.ChessteinAnalysis = {
    LABELS,
    ANALYSIS_FORMULA_VERSION,
    ANALYSIS_FEATURE_VERSION,
    scoreToWhitePercent,
    formatWhiteScore,
    expectedPointsForWhite,
    expectedPointsForColor,
    expectedPointsFromWhiteWdl,
    normalizeWdlForWhite,
    normalizeScoreForWhite,
    classifyMove,
    moveAccuracyFromLoss,
    summarizeAccuracy,
    averageAccuracy,
    enrichReviewAnalysis
  };
})();
