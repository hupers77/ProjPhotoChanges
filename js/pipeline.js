// One photo in, one encoded Blob out. Overlays (signature, EXIF text) plug in
// via registerOverlay so step 2 doesn't need to touch the resize code.

import { computeTargetSize, drawResized } from './resize.js';
import { buildFileName } from './filename.js';

const overlays = [];

// fn(ctx2d, { width, height, file, index, settings, meta }) — may be async.
export function registerOverlay(fn) { overlays.push(fn); }

const SUPPORTED_OUT = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function outputMime(file, format) {
  if (format !== 'same') return format;
  return SUPPORTED_OUT.has(file.type) ? file.type : 'image/jpeg';
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // Applies the EXIF Orientation so portrait shots come out upright.
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall through to <img> (e.g. HEIC in Safari) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function encode(canvas, mime, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: mime, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('인코딩 실패'))), mime, quality));
}

export async function processFile(file, index, settings) {
  const img = await decode(file);
  try {
    const { width, height } = computeTargetSize(img.width, img.height, settings.resize);
    const mime = outputMime(file, settings.output.format);
    const canvas = drawResized(img.source, img.width, img.height, width, height);
    const ctx = canvas.getContext('2d');

    if (mime === 'image/jpeg') {
      // JPEG has no alpha: flatten transparent PNGs onto white instead of black.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }

    const meta = { srcWidth: img.width, srcHeight: img.height };
    for (const fn of overlays) await fn(ctx, { width, height, file, index, settings, meta });

    const blob = await encode(canvas, mime, settings.output.quality / 100);
    const name = buildFileName(settings.output.namePattern, {
      fileName: file.name, index, date: new Date(file.lastModified),
    }, mime);
    return { blob, name, width, height };
  } finally {
    img.close();
  }
}
