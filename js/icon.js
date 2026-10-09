// Icon (.ico) output: a center-cropped square of the photo at 16 and 32 px,
// packed as PNG images inside one .ico file. Resize, effects, signature and
// EXIF settings are deliberately not applied.

import { drawResized, makeCanvas } from './resize.js';

export const ICON_MIME = 'image/x-icon';
export const ICON_SIZES = [32, 16];

// Largest centered square of the source, scaled down to 64 px (or less for tiny sources).
function squareBase(source, srcW, srcH) {
  const side = Math.min(srcW, srcH);
  const sx = Math.floor((srcW - side) / 2), sy = Math.floor((srcH - side) / 2);
  const edge = Math.min(side, 64);
  // Halve straight from the source rect so big photos don't need a full-size square copy.
  let cur = source, curSide = side, ox = sx, oy = sy;
  while (curSide / 2 >= edge) {
    const s = Math.round(curSide / 2);
    const step = makeCanvas(s, s);
    const ctx = step.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, ox, oy, curSide, curSide, 0, 0, s, s);
    cur = step; curSide = s; ox = 0; oy = 0;
  }
  const out = makeCanvas(edge, edge);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, ox, oy, curSide, curSide, 0, 0, edge, edge);
  return { canvas: out, edge };
}

export function iconCanvases(source, srcW, srcH) {
  const { canvas, edge } = squareBase(source, srcW, srcH);
  return ICON_SIZES.map(size => ({ size, canvas: drawResized(canvas, edge, edge, size, size) }));
}

async function toPng(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('인코딩 실패'))), 'image/png'));
}

// ICONDIR + ICONDIRENTRY[] + PNG payloads (PNG-in-ICO, supported by Windows Vista+ and macOS).
export async function encodeIco(images) {
  const pngs = await Promise.all(images.map(async ({ size, canvas }) =>
    ({ size, bytes: new Uint8Array(await (await toPng(canvas)).arrayBuffer()) })));
  const headerLen = 6 + 16 * pngs.length;
  const head = new DataView(new ArrayBuffer(headerLen));
  head.setUint16(0, 0, true);
  head.setUint16(2, 1, true);
  head.setUint16(4, pngs.length, true);
  let offset = headerLen;
  pngs.forEach(({ size, bytes }, i) => {
    const p = 6 + 16 * i;
    head.setUint8(p, size >= 256 ? 0 : size);
    head.setUint8(p + 1, size >= 256 ? 0 : size);
    head.setUint8(p + 2, 0);
    head.setUint8(p + 3, 0);
    head.setUint16(p + 4, 1, true);
    head.setUint16(p + 6, 32, true);
    head.setUint32(p + 8, bytes.length, true);
    head.setUint32(p + 12, offset, true);
    offset += bytes.length;
  });
  return new Blob([head.buffer, ...pngs.map(p => p.bytes)], { type: ICON_MIME });
}
