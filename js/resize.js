// Pure size math plus high-quality canvas downscaling.

export function computeTargetSize(srcW, srcH, opt) {
  let scale;
  switch (opt.mode) {
    case 'long': scale = opt.longEdge / Math.max(srcW, srcH); break;
    case 'short': scale = opt.shortEdge / Math.min(srcW, srcH); break;
    case 'width': scale = opt.width / srcW; break;
    case 'height': scale = opt.height / srcH; break;
    case 'box': scale = Math.min(opt.boxW / srcW, opt.boxH / srcH); break;
    case 'percent': scale = opt.percent / 100; break;
    default: scale = 1;
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  if (opt.noEnlarge && scale > 1) scale = 1;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Large reductions in a single drawImage alias badly in some browsers,
// so halve repeatedly until within 2x of the target, then do the final step.
export function drawResized(source, srcW, srcH, dstW, dstH) {
  let cur = source, curW = srcW, curH = srcH;
  while (curW / 2 >= dstW && curH / 2 >= dstH) {
    const w = Math.round(curW / 2), h = Math.round(curH / 2);
    const step = makeCanvas(w, h);
    const sctx = step.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, 0, 0, w, h);
    cur = step; curW = w; curH = h;
  }
  const out = makeCanvas(dstW, dstH);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, dstW, dstH);
  return out;
}

export { makeCanvas };
