// One photo in, one encoded Blob out. Overlays (signature, EXIF text) plug in
// via registerOverlay so they don't need to touch the resize code.

import { computeTargetSize, drawResized } from './resize.js';
import { buildFileName } from './filename.js';
import { readExif, exifForOutput, insertExif, exifTokens, photoDate, sourceDpi } from './exif.js';
import { swapsSides, rotateCanvas, drawRotated, applyEffects } from './effects.js';
import { applyDpi } from './dpi.js';
import { ICON_MIME, iconCanvases, encodeIco } from './icon.js';

const overlays = [];

// fn(ctx2d, { width, height, file, index, settings, meta }) — may be async.
export function registerOverlay(fn) { overlays.push(fn); }

const SUPPORTED_OUT = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function outputMime(file, format) {
  if (format !== 'same') return format;
  return SUPPORTED_OUT.has(file.type) ? file.type : 'image/jpeg';
}

// Output size for a source of srcW x srcH, after the optional rotation.
export function targetSize(srcW, srcH, settings) {
  if (settings.output.format === ICON_MIME) return { width: 32, height: 32 };
  const swap = swapsSides(settings.effects?.rotate);
  return computeTargetSize(swap ? srcH : srcW, swap ? srcW : srcH, settings.resize);
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

function flattenForJpeg(ctx, width, height) {
  // JPEG has no alpha: flatten transparent PNGs onto white instead of black.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

async function applyOverlays(ctx, o) {
  for (const fn of overlays) await fn(ctx, o);
}

async function encode(canvas, mime, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: mime, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('인코딩 실패'))), mime, quality));
}

// Icon output ignores every other setting: one .ico per size (name_32.ico, name_16.ico).
async function processIcon(file, index, settings) {
  const exif = await readExif(file);
  const img = await decode(file);
  try {
    const name = buildFileName(settings.output.namePattern, {
      fileName: file.name, index, date: photoDate(file, exif),
    }, ICON_MIME);
    const stem = name.slice(0, -'.ico'.length);
    const files = await Promise.all(iconCanvases(img.source, img.width, img.height).map(async (icon) =>
      ({ name: `${stem}_${icon.size}.ico`, blob: await encodeIco([icon]) })));
    return { files, width: 32, height: 32 };
  } finally {
    img.close();
  }
}

export async function processFile(file, index, settings) {
  if (settings.output.format === ICON_MIME) return processIcon(file, index, settings);
  const exif = await readExif(file);
  const img = await decode(file);
  try {
    const rot = settings.effects?.rotate || 0;
    const { width, height } = targetSize(img.width, img.height, settings);
    const mime = outputMime(file, settings.output.format);
    const swap = swapsSides(rot);
    const canvas = rotateCanvas(drawResized(img.source, img.width, img.height, swap ? height : width, swap ? width : height), rot);
    const ctx = canvas.getContext('2d');
    if (mime === 'image/jpeg') flattenForJpeg(ctx, width, height);
    applyEffects(ctx, width, height, settings.effects);

    const meta = { srcWidth: img.width, srcHeight: img.height, exif, tokens: exifTokens(exif?.tags, file) };
    await applyOverlays(ctx, { width, height, file, index, settings, meta });

    const dpi = settings.output.dpi === 'keep' ? await sourceDpi(file, exif) : Number(settings.output.dpi) || null;
    let blob = await encode(canvas, mime, settings.output.quality / 100);
    if (mime === 'image/jpeg' && settings.output.keepExif && exif?.app1) {
      try {
        const fixDpi = settings.output.dpi === 'keep' ? null : dpi;
        blob = await insertExif(blob, exifForOutput(exif.app1, { width, height, stripGps: settings.output.stripGps, dpi: fixDpi }));
      } catch { /* unusual EXIF layout: save without it rather than fail */ }
    }
    if (dpi) blob = await applyDpi(blob, mime, dpi);
    const name = buildFileName(settings.output.namePattern, {
      fileName: file.name, index, date: photoDate(file, exif),
    }, mime);
    return { blob, name, width, height };
  } finally {
    img.close();
  }
}

// ---------- preview ----------

// Decode once at a reduced size; renderPreview then redraws quickly on every
// settings change.
export async function loadPreviewBase(file, maxEdge = 1600) {
  const exif = await readExif(file);
  const img = await decode(file);
  try {
    const s = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const base = drawResized(img.source, img.width, img.height,
      Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
    return { base, srcWidth: img.width, srcHeight: img.height, exif, file };
  } finally {
    img.close();
  }
}

// Draws what the saved file will look like, scaled down, into a visible canvas.
export async function renderPreview(canvas, pb, index, settings) {
  if (settings.output.format === ICON_MIME) {
    // Show the 32 px icon blown up with hard pixels, as it will really look.
    const [icon32] = iconCanvases(pb.base, pb.base.width, pb.base.height);
    const edge = 256;
    canvas.width = edge; canvas.height = edge;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(icon32.canvas, 0, 0, edge, edge);
    return { width: 32, height: 32, icon: true };
  }
  const rot = settings.effects?.rotate || 0;
  const { width, height } = targetSize(pb.srcWidth, pb.srcHeight, settings);
  const bw = swapsSides(rot) ? pb.base.height : pb.base.width;
  const bh = swapsSides(rot) ? pb.base.width : pb.base.height;
  const s = Math.min(1, bw / width, bh / height);
  const pw = Math.max(1, Math.round(width * s)), ph = Math.max(1, Math.round(height * s));
  const work = document.createElement('canvas');
  work.width = pw; work.height = ph;
  const ctx = work.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawRotated(ctx, pb.base, rot, pw, ph);
  if (outputMime(pb.file, settings.output.format) === 'image/jpeg') flattenForJpeg(ctx, pw, ph);
  applyEffects(ctx, pw, ph, settings.effects);
  const meta = { srcWidth: pb.srcWidth, srcHeight: pb.srcHeight, exif: pb.exif, tokens: exifTokens(pb.exif?.tags, pb.file) };
  await applyOverlays(ctx, { width: pw, height: ph, file: pb.file, index, settings, meta });
  // Swap in one step so the visible canvas never flickers half-drawn.
  canvas.width = pw; canvas.height = ph;
  canvas.getContext('2d').drawImage(work, 0, 0);
  return { width, height };
}
