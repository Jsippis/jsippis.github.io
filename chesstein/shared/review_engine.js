(function () {
  'use strict';

  const DEFAULT_ENGINE_SCRIPT = '../gui/vendor/stockfish/stockfish-18-lite-single.js';
  const DEFAULT_ENGINE_WASM = '../gui/vendor/stockfish/stockfish-18-lite-single.wasm';
  const READY_TIMEOUT_MS = 45000;
  const UCI_RETRY_MS = 1000;
  const SEARCH_TIMEOUT_MS = 20000;

  function engineBaseUrl() {
    const script = document.currentScript || [...document.scripts].find((entry) =>
      entry.src && entry.src.endsWith('/review_engine.js')
    );
    return script?.src || window.location.href;
  }

  const ENGINE_BASE_URL = engineBaseUrl();

  function absoluteUrl(path) {
    return new URL(path, ENGINE_BASE_URL).href;
  }

  class StockfishReviewEngine {
    constructor(options = {}) {
      this.scriptPath = options.scriptPath || DEFAULT_ENGINE_SCRIPT;
      this.wasmPath = options.wasmPath || DEFAULT_ENGINE_WASM;
      this.worker = null;
      this.readyPromise = null;
      this.readyResolved = false;
      this.readyRejected = false;
      this.waiters = [];
      this.currentSearch = null;
      this.ticket = 0;
      this.lastLines = [];
    }

    isSupported() {
      return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
    }

    async init() {
      if (!this.isSupported()) {
        throw new Error('This browser does not support Web Workers and WebAssembly.');
      }
      if (this.readyPromise) return this.readyPromise;

      this.readyPromise = new Promise((resolve, reject) => {
        const scriptUrl = absoluteUrl(this.scriptPath);
        const wasmUrl = absoluteUrl(this.wasmPath);
        let timer = null;
        let uciRetry = null;

        const fail = (error) => {
          if (this.readyResolved || this.readyRejected) return;
          this.readyRejected = true;
          clearTimeout(timer);
          clearInterval(uciRetry);
          reject(error instanceof Error ? error : new Error(String(error)));
        };

        try {
          // Stockfish.js can find the matching .wasm when the worker script and
          // wasm file share the same basename. Avoid putting the wasm URL in the
          // worker fragment because some browsers/hosts do not reliably preserve
          // worker URL hashes during startup.
          this.worker = new Worker(scriptUrl);
        } catch (error) {
          try {
            this.worker = new Worker(`${scriptUrl}#${encodeURIComponent(wasmUrl)},worker`);
          } catch (_) {
            fail(error);
            return;
          }
        }

        timer = setTimeout(() => {
          const tail = this.lastLines.slice(-8).join(' | ');
          fail(new Error(tail
            ? `Stockfish WASM did not become ready. Last engine output: ${tail}`
            : 'Stockfish WASM did not become ready.'));
        }, READY_TIMEOUT_MS);

        this.worker.onerror = (event) => {
          fail(new Error(event.message || 'Stockfish worker failed to load.'));
        };

        this.worker.onmessage = (event) => {
          const line = String(event.data || '').trim();
          if (!line) return;
          this._handleLine(line);
          if (line === 'uciok') {
            // Keep browser/report analysis as repeatable as possible. Unsupported
            // UCI options are ignored by Stockfish, so these are safe across builds.
            this.post('setoption name Threads value 1');
            this.post('setoption name Hash value 32');
            this.post('setoption name MultiPV value 1');
            this.post('setoption name UCI_ShowWDL value true');
            this.post('isready');
          } else if (line === 'readyok' && !this.readyResolved) {
            this.readyResolved = true;
            clearTimeout(timer);
            clearInterval(uciRetry);
            resolve(this);
          }
        };

        // Posting immediately usually works, but retrying protects against slow
        // WASM startup or browsers that drop the very first early worker message.
        const sendUci = () => {
          if (!this.readyResolved && !this.readyRejected) this.post('uci');
        };
        setTimeout(sendUci, 50);
        uciRetry = setInterval(sendUci, UCI_RETRY_MS);
      });

      return this.readyPromise;
    }

    post(command) {
      if (!this.worker) return;
      this.worker.postMessage(command);
    }

    stop() {
      this.ticket++;
      if (this.currentSearch) {
        const search = this.currentSearch;
        clearTimeout(search.timer);
        this.currentSearch = null;
        try { search.reject(new Error('Analysis cancelled.')); } catch (_) {}
      }
      this.post('stop');
    }

    dispose() {
      this.stop();
      if (this.worker) {
        try { this.post('quit'); } catch (_) {}
        try { this.worker.terminate(); } catch (_) {}
      }
      this.worker = null;
      this.readyPromise = null;
      this.readyResolved = false;
      this.readyRejected = false;
      this.waiters = [];
    }

    async analyzeFen(fen, options = {}) {
      await this.init();

      const depth = Number(options.depth || 12);
      const nodes = Number(options.nodes || 0);
      const searchMoves = (Array.isArray(options.searchMoves) ? options.searchMoves : [options.searchMoves])
        .map((move) => String(move || '').trim().toLowerCase())
        .filter((move) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move));
      const ticket = ++this.ticket;

      if (this.currentSearch) {
        const previous = this.currentSearch;
        clearTimeout(previous.timer);
        this.currentSearch = null;
        try { previous.reject(new Error('Analysis cancelled.')); } catch (_) {}
      }
      this.post('stop');
      await this._readyCheck();
      if (ticket !== this.ticket) throw new Error('Analysis cancelled.');
      if (options.clearHash) {
        this.post('setoption name Clear Hash');
        await this._readyCheck();
        if (ticket !== this.ticket) throw new Error('Analysis cancelled.');
      }

      return new Promise((resolve, reject) => {
        const result = {
          fen,
          depth: 0,
          score: null,
          wdl: null,
          pv: [],
          bestmove: null,
          rawLines: [],
          stoppedEarly: false,
          stopReason: null
        };
        const timer = setTimeout(() => {
          if (this.currentSearch && this.currentSearch.ticket === ticket) {
            this.currentSearch = null;
            this.post('stop');
          }
          reject(new Error('Stockfish analysis timed out.'));
        }, Number(options.timeoutMs || SEARCH_TIMEOUT_MS));

        this.currentSearch = {
          ticket,
          resolve,
          reject,
          result,
          timer,
          options,
          startedAt: Date.now(),
          lastStableSignature: null,
          stableCount: 0,
          stopRequested: false
        };
        this.post(`position fen ${fen}`);
        const go = ['go'];
        if (searchMoves.length) go.push('searchmoves', ...searchMoves);
        if (nodes > 0) go.push('nodes', String(Math.max(1, Math.min(5000000, Math.round(nodes)))));
        else go.push('depth', String(Math.max(1, Math.min(30, depth))));
        this.post(go.join(' '));
      });
    }

    _readyCheck() {
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate: (line) => line === 'readyok',
          resolve,
          reject,
          timer: setTimeout(() => {
            this.waiters = this.waiters.filter((entry) => entry !== waiter);
            reject(new Error('Stockfish ready check timed out.'));
          }, READY_TIMEOUT_MS)
        };
        this.waiters.push(waiter);
        this.post('isready');
      });
    }

    _handleLine(line) {
      this.lastLines.push(line);
      if (this.lastLines.length > 80) this.lastLines.shift();

      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(line)) {
          clearTimeout(waiter.timer);
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          waiter.resolve(line);
        }
      }

      const search = this.currentSearch;
      if (!search) return;
      search.result.rawLines.push(line);
      if (search.result.rawLines.length > 50) search.result.rawLines.shift();

      if (line.startsWith('info ')) {
        const changed = this._parseInfoLine(line, search.result);
        if (changed) this._handleProgress(search);
        return;
      }

      if (line.startsWith('bestmove ')) {
        const parts = line.split(/\s+/);
        search.result.bestmove = parts[1] || null;
        clearTimeout(search.timer);
        this.currentSearch = null;
        search.resolve({ ...search.result });
      }
    }

    _handleProgress(search) {
      const { options, result } = search;
      if (typeof options.onUpdate === 'function') {
        try { options.onUpdate({ ...result, pv: [...result.pv], rawLines: [...result.rawLines] }); } catch (_) {}
      }
      if (!options.progressive || search.stopRequested || !result.depth) return;

      const minDepth = Math.max(1, Number(options.minDepth || 10));
      const stableDepths = Math.max(1, Number(options.stableDepths || 3));
      const maxTimeMs = Math.max(750, Number(options.maxTimeMs || 6500));
      const elapsed = Date.now() - search.startedAt;

      if (elapsed >= maxTimeMs && result.depth >= Math.max(4, minDepth - 2)) {
        result.stoppedEarly = true;
        result.stopReason = 'time';
        search.stopRequested = true;
        this.post('stop');
        return;
      }

      if (result.depth < minDepth || !result.pv?.length || !result.score) return;

      const best = result.pv[0] || '';
      const scoreKey = this._scoreStableKey(result.score, options.scoreToleranceCp);
      const signature = `${best}|${scoreKey}`;
      if (signature === search.lastStableSignature) {
        search.stableCount += 1;
      } else {
        search.lastStableSignature = signature;
        search.stableCount = 1;
      }

      if (search.stableCount >= stableDepths) {
        result.stoppedEarly = true;
        result.stopReason = 'stable';
        search.stopRequested = true;
        this.post('stop');
      }
    }

    _scoreStableKey(score, toleranceCp = 14) {
      if (!score) return 'none';
      if (score.type === 'mate') {
        return `mate:${Math.sign(score.value || 0)}:${Math.min(12, Math.abs(Number(score.value || 0)))}`;
      }
      const bucket = Math.max(1, Number(toleranceCp || 14));
      return `cp:${Math.round(Number(score.value || 0) / bucket)}`;
    }

    _parseInfoLine(line, result) {
      let changed = false;
      const depthMatch = line.match(/\bdepth\s+(\d+)/);
      if (depthMatch) {
        const depth = Number(depthMatch[1]);
        if (depth !== result.depth) changed = true;
        result.depth = depth;
      }

      const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
      if (scoreMatch) {
        result.score = {
          type: scoreMatch[1],
          value: Number(scoreMatch[2])
        };
        changed = true;
      }

      const wdlMatch = line.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (wdlMatch) {
        result.wdl = {
          win: Number(wdlMatch[1]),
          draw: Number(wdlMatch[2]),
          loss: Number(wdlMatch[3])
        };
        changed = true;
      }

      const pvMatch = line.match(/\bpv\s+(.+)$/);
      if (pvMatch) {
        result.pv = pvMatch[1].trim().split(/\s+/).filter(Boolean);
        changed = true;
      }
      return changed;
    }
  }

  window.ChessteinReviewEngine = StockfishReviewEngine;
})();
