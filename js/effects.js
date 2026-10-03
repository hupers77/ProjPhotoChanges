// Pixel-level adjustments applied after resizing: rotation, auto level and
// sharpening. Works on any 2D canvas, on the page or in a worker.

import { makeCanvas } from './resize.js';

export const swapsSides = (deg) => deg === 90 || deg === 270;

// Draws `src` rotated clockwise by `deg` so it fills W x H (the rotated size).
export function drawRotated(ctx, src, deg, W, H) {
  ctx.save();
  if (deg === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0, H, W); }
  else if (deg === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); ctx.drawImage(src, 0, 0, W, H); }
  else if (deg === 270) { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); ctx.drawImage(src, 0, 0, H, W); }
  else ctx.drawImage(src, 0, 0, W, H);
  ctx.restore();
}

export function rotateCanvas(src, deg) {
  if (!deg) return src;
  const W = swapsSides(deg) ? src.height : src.width;
  const H = swapsSides(deg) ? src.width : src.height;
  const out = makeCanvas(W, H);
  drawRotated(out.getContext('2d'), src, deg, W, H);
  return out;
}

// One brightness curve for all channels (keeps colours as they are), taken
// from the luminance histogram with the darkest/brightest 0.5% clipped.
function autoLevel(d) {
  const hist = new Uint32Array(256);
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const clip = n * 0.005;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) <= clip) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) <= clip) hi--;
  if (hi - lo < 16 || (lo <= 2 && hi >= 253)) return; // flat image or already full range
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

// Unsharp mask with a small (1-2-1) blur: out = px + amount * (px - blur).
function sharpen(d, W, H, strength) {
  const amount = (strength / 100) * 1.6;
  const tmp = new Uint8ClampedArray(d.length);
  const row = W * 4;
  // horizontal pass
  for (let y = 0; y < H; y++) {
    const base = y * row;
    for (let x = 0; x < W; x++) {
      const i = base + x * 4;
      const l = x > 0 ? i - 4 : i, r = x < W - 1 ? i + 4 : i;
      for (let c = 0; c < 3; c++) tmp[i + c] = (d[l + c] + 2 * d[i + c] + d[r + c] + 2) >> 2;
    }
  }
  // vertical pass, then mix
  for (let y = 0; y < H; y++) {
    const up = y > 0 ? -row : 0, dn = y < H - 1 ? row : 0;
    for (let x = 0; x < W; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (tmp[i + up + c] + 2 * tmp[i + c] + tmp[i + dn + c] + 2) >> 2;
        const v = d[i + c];
        d[i + c] = v + amount * (v - blur);
      }
    }
  }
}

export function applyEffects(ctx, W, H, fx) {
  if (!fx || (!fx.autoLevel && !(fx.sharpen > 0))) return;
  const img = ctx.getImageData(0, 0, W, H);
  if (fx.autoLevel) autoLevel(img.data);
  if (fx.sharpen > 0) sharpen(img.data, W, H, Math.min(100, fx.sharpen));
  ctx.putImageData(img, 0, 0);
}
