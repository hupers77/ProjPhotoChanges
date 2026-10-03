// Background worker: runs the same per-photo pipeline as the page, so a batch
// uses several CPU cores and the page stays responsive.

import { processFile, registerOverlay } from './pipeline.js';
import { drawOverlays, setSignatureImage } from './overlay.js';

registerOverlay(drawOverlays);

let signatureReady = Promise.resolve();

function canRender() {
  try {
    const c = new OffscreenCanvas(1, 1);
    return !!c.getContext('2d') && typeof c.convertToBlob === 'function';
  } catch {
    return false;
  }
}

async function makeThumb(file, maxEdge) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { width: bmp.width, height: bmp.height, blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) };
  } finally {
    bmp.close();
  }
}

const tasks = {
  async process({ file, index, settings }) {
    await signatureReady;
    return processFile(file, index, settings);
  },
  thumb: ({ file, maxEdge }) => makeThumb(file, maxEdge),
};

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'probe') {
    self.postMessage({ type: 'probe', ok: canRender() });
    return;
  }
  if (m.type === 'signature') {
    signatureReady = (async () => {
      setSignatureImage(m.blob ? await createImageBitmap(m.blob) : null);
    })().catch(() => setSignatureImage(null));
    return;
  }
  try {
    const result = await tasks[m.type](m.payload);
    self.postMessage({ id: m.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err?.message || err) });
  }
};
