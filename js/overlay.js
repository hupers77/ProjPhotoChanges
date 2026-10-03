// Draws the signature (text or image) and the EXIF info text onto a photo.
// Sizes are relative to the photo, so a small preview looks exactly like the
// full-size output.

const FONTS = {
  sans: 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  serif: '"AppleMyungjo", "Apple Myungjo", "Nanum Myeongjo", "Batang", serif',
  mono: 'ui-monospace, Menlo, "D2Coding", Consolas, monospace',
};

let signatureImage = null;
export function setSignatureImage(img) { signatureImage = img; }
export function getSignatureImage() { return signatureImage; }

// Separators between template parts. A part whose tokens are all empty is
// dropped together with the separator before it, so "{카메라} · {렌즈}"
// without lens info becomes just the camera name.
const SEP = /(\s*[|·•]\s*|\s+\/\s+|,\s+)/;
const TOKEN = /\{([^}]+)\}/g;

export function fillTemplate(template, tokens) {
  const lines = [];
  for (const line of String(template || '').split(/\r?\n/)) {
    const parts = line.split(SEP);
    const kept = [];
    for (let i = 0; i < parts.length; i += 2) {
      const raw = parts[i];
      let hadToken = false, anyValue = false;
      const val = raw.replace(TOKEN, (m, key) => {
        if (!(key in tokens)) return m;
        hadToken = true;
        if (tokens[key]) anyValue = true;
        return tokens[key];
      }).replace(/\s+/g, ' ').trim();
      if (!val || (hadToken && !anyValue)) continue;
      kept.push((kept.length ? parts[i - 1] || '' : '') + val);
    }
    const text = kept.join('');
    if (text.trim()) lines.push(text);
  }
  return lines;
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

function textItem(ctx, lines, opt, W, H, short) {
  const margin = short * opt.margin / 100;
  let size = short * opt.size / 100;
  const font = (px) => `${opt.bold ? 'bold ' : ''}${px}px ${FONTS[opt.font] || FONTS.sans}`;
  ctx.save();
  ctx.font = font(size);
  let widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  const pad0 = opt.effect === 'box' ? 0.45 : 0;
  const room = W - 2 * margin;
  // Shrink long lines to fit inside the photo instead of running off the edge.
  if (widest + 2 * pad0 * size > room && widest > 0) {
    const s = room / (widest + 2 * pad0 * size);
    size *= s; widest *= s;
  }
  ctx.restore();
  const lineH = size * 1.3;
  const pad = pad0 * size;
  const w = widest + pad * 2;
  const h = lines.length * lineH + pad * 2;
  return {
    pos: opt.position, margin, w, h,
    draw(ctx, x, y) {
      const light = isLight(opt.color);
      ctx.save();
      ctx.globalAlpha = opt.opacity / 100;
      if (opt.effect === 'box') {
        ctx.fillStyle = light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, size * 0.3); else ctx.rect(x, y, w, h);
        ctx.fill();
      }
      ctx.font = font(size);
      ctx.textBaseline = 'middle';
      const align = opt.position[1] === 'l' ? 'left' : opt.position[1] === 'r' ? 'right' : 'center';
      ctx.textAlign = align;
      const tx = align === 'left' ? x + pad : align === 'right' ? x + w - pad : x + w / 2;
      if (opt.effect === 'shadow') {
        ctx.shadowColor = light ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.7)';
        ctx.shadowBlur = size * 0.18;
        ctx.shadowOffsetX = ctx.shadowOffsetY = size * 0.05;
      }
      ctx.fillStyle = opt.color;
      ctx.strokeStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = size * 0.12;
      ctx.lineJoin = 'round';
      lines.forEach((line, i) => {
        const ty = y + pad + lineH * (i + 0.5);
        if (opt.effect === 'outline') ctx.strokeText(line, tx, ty);
        ctx.fillText(line, tx, ty);
      });
      ctx.restore();
    },
  };
}

function imageItem(img, opt, W, H, short) {
  const margin = short * opt.margin / 100;
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  let w = W * opt.imageWidth / 100;
  let h = w * ih / iw;
  const maxW = W - 2 * margin, maxH = H - 2 * margin;
  const s = Math.min(1, maxW / w, maxH / h);
  w *= s; h *= s;
  return {
    pos: opt.position, margin, w, h,
    draw(ctx, x, y) {
      ctx.save();
      ctx.globalAlpha = opt.opacity / 100;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
    },
  };
}

// Overlay hook for pipeline.registerOverlay.
export function drawOverlays(ctx, { width: W, height: H, settings, meta }) {
  const short = Math.min(W, H);
  const tokens = meta.tokens || {};
  // Order = from the photo edge inward when both share a position.
  const items = [];
  const ex = settings.exifOverlay;
  if (ex.enabled) {
    const lines = fillTemplate(ex.template, tokens);
    if (lines.length) items.push(textItem(ctx, lines, ex, W, H, short));
  }
  const sg = settings.signature;
  if (sg.enabled) {
    if (sg.kind === 'image') {
      if (signatureImage) items.push(imageItem(signatureImage, sg, W, H, short));
    } else {
      const lines = fillTemplate(sg.text, tokens);
      if (lines.length) items.push(textItem(ctx, lines, sg, W, H, short));
    }
  }

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.pos)) groups.set(it.pos, []);
    groups.get(it.pos).push(it);
  }
  for (const [pos, list] of groups) {
    const v = pos[0], hz = pos[1];
    const margin = Math.max(...list.map(i => i.margin));
    const gap = short * 0.012;
    const total = list.reduce((s, i) => s + i.h, 0) + gap * (list.length - 1);
    const stack = v === 'b' ? [...list].reverse() : list;
    let y = v === 't' ? margin : v === 'b' ? H - margin - total : (H - total) / 2;
    for (const it of stack) {
      const x = hz === 'l' ? it.margin : hz === 'r' ? W - it.margin - it.w : (W - it.w) / 2;
      it.draw(ctx, x, y);
      y += it.h + gap;
    }
  }
}
