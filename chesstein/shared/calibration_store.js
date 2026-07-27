(function () {
  'use strict';

  const DB_NAME = 'chesstein-calibration';
  const DB_VERSION = 1;
  const STORE_NAME = 'upload-queue';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is unavailable.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sampleId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open calibration queue.'));
    });
  }

  async function withStore(mode, operation) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let value;
        try { value = operation(store); }
        catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(value?.result ?? value);
        tx.onerror = () => reject(tx.error || new Error('Calibration queue transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('Calibration queue transaction was aborted.'));
      });
    } finally {
      db.close();
    }
  }

  function put(sample) {
    return withStore('readwrite', (store) => store.put(sample));
  }

  function remove(sampleId) {
    return withStore('readwrite', (store) => store.delete(sampleId));
  }

  function getAll() {
    return withStore('readonly', (store) => store.getAll());
  }

  async function count() {
    try {
      return await withStore('readonly', (store) => store.count());
    } catch (_) {
      return 0;
    }
  }

  async function hashText(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function postSample(endpoint, sample) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sample),
      keepalive: true
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.message || data.error || `Calibration upload failed (${response.status}).`);
    }
    return data;
  }

  async function submitOrQueue(endpoint, sample) {
    await put(sample);
    try {
      const response = await postSample(endpoint, sample);
      await remove(sample.sampleId);
      return { uploaded: true, queued: false, response };
    } catch (error) {
      return { uploaded: false, queued: true, error };
    }
  }

  async function flushQueue(endpoint, options = {}) {
    let samples;
    try { samples = await getAll(); }
    catch (_) { return { uploaded: 0, remaining: 0 }; }

    const limit = Math.max(1, Math.min(50, Number(options.limit || 12)));
    let uploaded = 0;
    for (const sample of samples.slice(0, limit)) {
      try {
        await postSample(endpoint, sample);
        await remove(sample.sampleId);
        uploaded += 1;
      } catch (_) {
        // Keep failed records for a later page load or analysis run.
      }
    }
    return { uploaded, remaining: await count() };
  }

  window.ChessteinCalibration = {
    DB_NAME,
    STORE_NAME,
    hashText,
    submitOrQueue,
    flushQueue,
    count
  };
})();
