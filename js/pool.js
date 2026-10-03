// A small pool of background workers. Batch jobs go ahead of thumbnails, and
// each worker handles one photo at a time (decoding is CPU- and memory-heavy).
// createPool resolves to null where workers can't draw (older browsers), and
// callers then do the work on the page as before.

const PROBE_TIMEOUT = 4000;

function startWorker() {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const done = (ok) => {
      clearTimeout(timer);
      w.onmessage = w.onerror = null;
      if (ok) resolve(w); else { w.terminate(); resolve(null); }
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT);
    w.onmessage = (e) => done(e.data?.type === 'probe' && e.data.ok);
    w.onerror = () => done(false);
    w.postMessage({ type: 'probe' });
  });
}

// Up to 4 workers: more rarely helps and each full-size photo needs ~100-200 MB.
export function defaultPoolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(4, cores - 1));
}

export async function createPool(size = defaultPoolSize()) {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  const workers = (await Promise.all(Array.from({ length: size }, startWorker))).filter(Boolean);
  if (!workers.length) return null;
  return new Pool(workers);
}

class Pool {
  constructor(workers) {
    this.size = workers.length;
    this.idle = [];
    this.queues = { high: [], low: [] };
    this.pending = new Map();
    this.nextId = 1;
    for (const w of workers) {
      w.onmessage = (e) => this.onMessage(w, e.data);
      w.onerror = (e) => { e.preventDefault?.(); this.onCrash(w); };
      this.idle.push(w);
    }
    this.signature = null;
  }

  setSignature(blob) {
    this.signature = blob || null;
    for (const w of this.all()) w.postMessage({ type: 'signature', blob: this.signature });
  }

  all() {
    return [...this.idle, ...[...this.pending.values()].map(p => p.worker)];
  }

  run(type, payload, priority = 'high') {
    return new Promise((resolve, reject) => {
      this.queues[priority].push({ type, payload, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.idle.length) {
      const job = this.queues.high.shift() || this.queues.low.shift();
      if (!job) return;
      const worker = this.idle.pop();
      const id = this.nextId++;
      this.pending.set(id, { ...job, worker });
      worker.postMessage({ id, type: job.type, payload: job.payload });
    }
  }

  onMessage(worker, m) {
    const job = this.pending.get(m.id);
    if (!job) return;
    this.pending.delete(m.id);
    this.idle.push(worker);
    if (m.ok) job.resolve(m.result); else job.reject(new Error(m.error));
    this.pump();
  }

  // A worker that dies (e.g. out of memory) fails its job; replace it.
  async onCrash(worker) {
    for (const [id, job] of this.pending) {
      if (job.worker !== worker) continue;
      this.pending.delete(id);
      job.reject(new Error('작업 중 오류'));
    }
    worker.terminate();
    const fresh = await startWorker();
    if (fresh) {
      fresh.onmessage = (e) => this.onMessage(fresh, e.data);
      fresh.onerror = (e) => { e.preventDefault?.(); this.onCrash(fresh); };
      if (this.signature) fresh.postMessage({ type: 'signature', blob: this.signature });
      this.idle.push(fresh);
    } else {
      this.size--;
    }
    if (!this.all().length) {
      // Nothing left to run on: fail what's queued so callers fall back.
      for (const job of [...this.queues.high.splice(0), ...this.queues.low.splice(0)]) job.reject(new Error('작업 중 오류'));
      return;
    }
    this.pump();
  }
}
