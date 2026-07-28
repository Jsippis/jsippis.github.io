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

  const ANALYSIS_FORMULA_VERSION = 'contextual-conversion-v5';
  const ANALYSIS_FEATURE_VERSION = 4;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value)));
  }

  function normalizedColor(color) {
    return color === 'black' || color === 'b' ? 'black' : 'white';
  }

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
    if (wdlExpected !== null) return clamp(wdlExpected * 100, 0, 100);
    if (!whiteScore) return 50;
    if (whiteScore.type === 'mate') return whiteScore.mate > 0 ? 100 : 0;
    const cp = clamp(Number(whiteScore.cp || 0), -1200, 1200);
    return clamp(100 / (1 + Math.exp(-cp / 300)), 1, 99);
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
    return normalizedColor(color) === 'black' ? 1 - whiteEp : whiteEp;
  }

  function normalizeScoreForWhite(score, positionOrTurn) {
    if (!score) return null;
    const turn = typeof positionOrTurn === 'string' ? positionOrTurn : positionOrTurn?.turn;
    const sign = turn === 'w' || turn === 'white' ? 1 : -1;
    if (score.type === 'mate') return { type: 'mate', mate: Number(score.value || 0) * sign };
    return { type: 'cp', cp: Number(score.value || 0) * sign };
  }

  function scoreForColor(whiteScore, color) {
    if (!whiteScore) return null;
    const sign = normalizedColor(color) === 'black' ? -1 : 1;
    if (whiteScore.type === 'mate') return { type: 'mate', value: Number(whiteScore.mate || 0) * sign };
    return { type: 'cp', value: Number(whiteScore.cp || 0) * sign };
  }

  function mateDistanceForColor(whiteScore, color) {
    const score = scoreForColor(whiteScore, color);
    return score?.type === 'mate' ? Number(score.value || 0) : null;
  }

  function centipawnsForColor(whiteScore, color) {
    const score = scoreForColor(whiteScore, color);
    return score?.type === 'cp' ? Number(score.value || 0) : null;
  }

  function mateAgainstColor(whiteScore, color) {
    const mate = mateDistanceForColor(whiteScore, color);
    return mate !== null && mate < 0;
  }

  function moveAccuracyFromLoss(loss) {
    const n = Math.max(0, Number(loss || 0));
    if (n <= 0.003) return 100;
    const score = 100 / (1 + Math.pow(n / 0.145, 1.72));
    return clamp(score, 0, 100);
  }

  function saturatedCpConversionPenalty(bestCp, playedCp) {
    if (!Number.isFinite(bestCp) || !Number.isFinite(playedCp)) return 0;
    const gap = Math.max(0, bestCp - playedCp);
    // WDL saturates in winning positions. This restrained secondary curve keeps
    // +8 versus +3, for example, distinguishable without treating both as a
    // game-changing error. A non-best move still receives a tiny floor.
    return Math.min(0.085, 0.006 + 0.075 * (1 - Math.exp(-gap / 300)));
  }

  function conversionDetails(options) {
    const {
      playedBest,
      sameRootComparison,
      bestEp,
      actualEp,
      bestWhiteScore,
      playedWhiteScore,
      mover
    } = options;

    const result = {
      conversionLoss: 0,
      bestMateDistance: mateDistanceForColor(bestWhiteScore, mover),
      playedMateDistance: mateDistanceForColor(playedWhiteScore, mover),
      mateDelay: 0,
      slowerMate: false,
      missedForcedMate: false,
      cpGap: 0
    };

    if (playedBest || !sameRootComparison) return result;

    const bestMate = result.bestMateDistance;
    const playedMate = result.playedMateDistance;

    if (bestMate !== null && bestMate > 0) {
      if (playedMate !== null && playedMate > 0) {
        result.mateDelay = Math.max(0, Math.round(Math.abs(playedMate) - Math.abs(bestMate)));
        result.slowerMate = result.mateDelay > 0;
        result.conversionLoss = result.mateDelay > 0
          ? Math.min(0.14, 0.035 + 0.020 * result.mateDelay)
          : 0.008;
        return result;
      }

      // The best move had a proven mate, but the played move no longer shows one
      // at the same node budget. If the result is still overwhelmingly winning,
      // treat it as an inefficient/missed conversion rather than a blunder.
      if (actualEp >= 0.95) {
        result.missedForcedMate = true;
        result.conversionLoss = bestMate <= 1 ? 0.085 : bestMate <= 3 ? 0.070 : 0.055;
        return result;
      }
    }

    if (bestEp >= 0.975 && actualEp >= 0.95) {
      const bestCp = centipawnsForColor(bestWhiteScore, mover);
      const playedCp = centipawnsForColor(playedWhiteScore, mover);
      if (Number.isFinite(bestCp) && Number.isFinite(playedCp)) {
        result.cpGap = Math.max(0, bestCp - playedCp);
        result.conversionLoss = saturatedCpConversionPenalty(bestCp, playedCp);
        return result;
      }
    }

    // A different move should never become "Best" merely because two WDL
    // values round to the same expected score.
    if (bestEp - actualEp <= 0.005) result.conversionLoss = 0.006;
    return result;
  }

  function labelForMove(details) {
    if (details.mateTransition) return 'blunder';
    if (details.playedBest) return 'best';

    if (details.slowerMate) {
      if (details.mateDelay <= 2) return 'good';
      if (details.mateDelay <= 4) return 'inaccuracy';
      return 'mistake';
    }

    if (details.missedForcedMate) {
      if (details.effectiveLoss <= 0.05) return 'good';
      if (details.effectiveLoss <= 0.10) return 'inaccuracy';
      return 'mistake';
    }

    if (details.effectiveLoss <= 0.02) return 'excellent';
    if (details.effectiveLoss <= 0.05) return 'good';
    if (details.effectiveLoss <= 0.10) return 'inaccuracy';
    if (details.effectiveLoss <= 0.20) return 'mistake';
    return 'blunder';
  }

  function classifyMove(options = {}) {
    const bestWhiteScore = options.bestWhiteScore || options.beforeWhiteScore;
    const playedWhiteScore = options.playedWhiteScore || options.afterWhiteScore;
    if (!bestWhiteScore || !playedWhiteScore) return null;

    const mover = normalizedColor(options.mover);
    const playedUci = options.playedUci || null;
    const bestUci = options.bestUci || null;
    const bestWhiteWdl = options.bestWhiteWdl || null;
    const playedWhiteWdl = options.playedWhiteWdl || null;
    const bestEp = expectedPointsForColor(bestWhiteScore, mover, bestWhiteWdl);
    const actualEp = expectedPointsForColor(playedWhiteScore, mover, playedWhiteWdl);
    const expectedPointsLoss = Math.max(0, bestEp - actualEp);
    const playedBest = !!playedUci && !!bestUci && String(playedUci).toLowerCase() === String(bestUci).toLowerCase();
    const legalMoveCount = Number.isFinite(Number(options.legalMoveCount)) ? Number(options.legalMoveCount) : null;
    const forced = legalMoveCount !== null && legalMoveCount <= 1;
    const settledWinning = bestEp >= 0.975;
    const settledLosing = bestEp <= 0.025;
    const settledBefore = settledWinning || settledLosing;
    const mateTransition = !mateAgainstColor(bestWhiteScore, mover) && mateAgainstColor(playedWhiteScore, mover);

    const conversion = conversionDetails({
      playedBest,
      sameRootComparison: options.sameRootComparison === true,
      bestEp,
      actualEp,
      bestWhiteScore,
      playedWhiteScore,
      mover
    });
    const effectiveLoss = Math.max(expectedPointsLoss, conversion.conversionLoss);
    const decisiveError = mateTransition || expectedPointsLoss >= 0.30 || (bestEp >= 0.20 && actualEp <= 0.02);

    const key = labelForMove({
      playedBest,
      mateTransition,
      slowerMate: conversion.slowerMate,
      mateDelay: conversion.mateDelay,
      missedForcedMate: conversion.missedForcedMate,
      effectiveLoss
    });

    let accuracy = moveAccuracyFromLoss(effectiveLoss);
    if (mateTransition) accuracy = Math.min(accuracy, 8);

    let decisionWeight = 1;
    if (forced) {
      decisionWeight = 0.12;
    } else if (settledLosing) {
      decisionWeight = 0.20;
    } else if (settledWinning) {
      // Easy best moves in a won position should not inflate the report, while
      // unnecessary detours and missed mates still need to count meaningfully.
      if (playedBest) decisionWeight = 0.25;
      else if (conversion.conversionLoss >= 0.02 || conversion.slowerMate || conversion.missedForcedMate) decisionWeight = 1;
      else decisionWeight = 0.55;
    }
    if (decisiveError) decisionWeight = Math.max(decisionWeight, mateTransition ? 1.8 : 1.5);

    const [label, shortLabel] = LABELS[key] || LABELS.good;
    const details = [];
    if (expectedPointsLoss > 0) details.push(`expected-points loss ${expectedPointsLoss.toFixed(3)}`);
    if (conversion.conversionLoss > 0) details.push(`conversion loss ${conversion.conversionLoss.toFixed(3)}`);
    if (conversion.slowerMate) details.push(`mate delayed by ${conversion.mateDelay}`);
    if (conversion.missedForcedMate) details.push('missed forced mate');
    if (mateTransition) details.push('allowed forced mate');

    return {
      key,
      label,
      shortLabel,
      // Keep `loss` as the effective scoring loss for existing UI/cache code.
      loss: effectiveLoss,
      expectedPointsLoss,
      conversionLoss: conversion.conversionLoss,
      accuracy,
      playedUci,
      bestUci,
      playedBest,
      exactBest: playedBest,
      bestExpectedPoints: bestEp,
      playedExpectedPoints: actualEp,
      legalMoveCount,
      forced,
      settledBefore,
      settledWinning,
      settledLosing,
      mateTransition,
      decisiveError,
      bestMateDistance: conversion.bestMateDistance,
      playedMateDistance: conversion.playedMateDistance,
      mateDelay: conversion.mateDelay,
      slowerMate: conversion.slowerMate,
      missedForcedMate: conversion.missedForcedMate,
      cpGap: conversion.cpGap,
      nonBestWinningMove: settledWinning && !playedBest,
      decisionWeight,
      meaningful: decisionWeight >= 0.5,
      title: `${label}${details.length ? ` · ${details.join(' · ')}` : ''}`
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
    const expectedLosses = [];
    const scoringLosses = [];
    const conversionLosses = [];
    const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
    let decisiveErrors = 0;
    let mateTransitions = 0;
    let forcedMoves = 0;
    let settledMoves = 0;
    let settledWinningMoves = 0;
    let settledLosingMoves = 0;
    let meaningfulMoves = 0;
    let exactBestMoves = 0;
    let slowerMateMoves = 0;
    let totalMateDelay = 0;
    let missedForcedMates = 0;
    let nonBestWinningMoves = 0;
    let conversionMoves = 0;

    for (const { classification } of entries) {
      const accuracy = clamp(Number(classification.accuracy), 0, 100);
      const weight = Math.max(0.05, Number(classification.decisionWeight || 1));
      const expectedLoss = Math.max(0, Number(classification.expectedPointsLoss ?? classification.loss ?? 0));
      const scoringLoss = Math.max(0, Number(classification.loss || 0));
      const conversionLoss = Math.max(0, Number(classification.conversionLoss || 0));
      weightedTotal += accuracy * weight;
      weightTotal += weight;
      logTotal += Math.log(Math.max(0.01, accuracy / 100)) * weight;
      accuracies.push(accuracy);
      expectedLosses.push(expectedLoss);
      scoringLosses.push(scoringLoss);
      conversionLosses.push(conversionLoss);
      if (counts[classification.key] !== undefined) counts[classification.key] += 1;
      if (classification.decisiveError) decisiveErrors += 1;
      if (classification.mateTransition) mateTransitions += 1;
      if (classification.forced) forcedMoves += 1;
      if (classification.settledBefore) settledMoves += 1;
      if (classification.settledWinning) settledWinningMoves += 1;
      if (classification.settledLosing) settledLosingMoves += 1;
      if (classification.meaningful) meaningfulMoves += 1;
      if (classification.exactBest || classification.playedBest) exactBestMoves += 1;
      if (classification.slowerMate) slowerMateMoves += 1;
      totalMateDelay += Math.max(0, Number(classification.mateDelay || 0));
      if (classification.missedForcedMate) missedForcedMates += 1;
      if (classification.nonBestWinningMove) nonBestWinningMoves += 1;
      if (conversionLoss > 0) conversionMoves += 1;
    }

    const weightedMean = weightTotal ? weightedTotal / weightTotal : mean(accuracies);
    const geometricMean = weightTotal ? Math.exp(logTotal / weightTotal) * 100 : mean(accuracies);
    const meaningfulAccuracies = entries
      .filter(({ classification }) => classification.meaningful)
      .map(({ classification }) => Number(classification.accuracy));
    const sorted = (meaningfulAccuracies.length ? meaningfulAccuracies : accuracies).slice().sort((a, b) => a - b);
    const worstCount = Math.max(1, Math.ceil(sorted.length * 0.25));
    const worstQuartileAccuracy = mean(sorted.slice(0, worstCount));
    // Use the weighted mean as the stable base. The older blend gave the
    // geometric mean and worst quartile too much influence, which could punish
    // the losing player twice for the same few decisive errors. A small tail
    // spread penalty preserves sensitivity to bad moves without crushing the
    // whole report.
    const tailPenalty = Math.min(4, Math.max(0, weightedMean - worstQuartileAccuracy) * 0.02);

    // WDL saturates once a position is won, so move-level scores alone still
    // under-punish repeated inefficient conversion. Scale the accumulated
    // conversion loss by the number of winning-position opportunities, then add
    // explicit penalties for missed or slower mates. This only applies while the
    // player was already winning; it does not further punish forced defence in a
    // lost position.
    const conversionPenalty = settledWinningMoves > 0
      ? Math.min(18,
          500 * (conversionLosses.reduce((sum, value) => sum + value, 0) / settledWinningMoves)
          + 1.25 * missedForcedMates
          + 0.40 * slowerMateMoves
          + 0.20 * totalMateDelay)
      : 0;

    const accuracy = clamp(weightedMean - tailPenalty - conversionPenalty, 0, 100);

    const sortedExpectedLosses = expectedLosses.slice().sort((a, b) => b - a);
    const sortedScoringLosses = scoringLosses.slice().sort((a, b) => b - a);
    return {
      accuracy,
      baseAccuracy: weightedMean,
      tailPenalty,
      conversionPenalty,
      weightedMeanAccuracy: weightedMean,
      geometricMeanAccuracy: geometricMean,
      worstQuartileAccuracy,
      meanMoveAccuracy: mean(accuracies),
      meanExpectedLoss: mean(expectedLosses),
      totalExpectedLoss: expectedLosses.reduce((sum, value) => sum + value, 0),
      worstExpectedLoss: sortedExpectedLosses[0] || 0,
      worstThreeExpectedLoss: mean(sortedExpectedLosses.slice(0, 3)) || 0,
      meanScoringLoss: mean(scoringLosses),
      worstScoringLoss: sortedScoringLosses[0] || 0,
      meanConversionLoss: mean(conversionLosses),
      totalConversionLoss: conversionLosses.reduce((sum, value) => sum + value, 0),
      bestMoveRate: entries.length ? exactBestMoves / entries.length : 0,
      exactBestMoves,
      moveCount: entries.length,
      meaningfulMoves,
      forcedMoves,
      settledMoves,
      settledWinningMoves,
      settledLosingMoves,
      decisiveErrors,
      mateTransitions,
      slowerMateMoves,
      totalMateDelay,
      missedForcedMates,
      nonBestWinningMoves,
      conversionMoves,
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
    scoreForColor,
    mateDistanceForColor,
    centipawnsForColor,
    classifyMove,
    moveAccuracyFromLoss,
    summarizeAccuracy,
    averageAccuracy,
    enrichReviewAnalysis
  };
})();
