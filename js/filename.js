// Output file naming from a token pattern.

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function extensionFor(mime) { return EXT[mime] || 'jpg'; }

function pad(n, width) { return String(n).padStart(width, '0'); }

function baseName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

// ctx: { fileName, index (0-based), date (Date) }
export function buildFileName(pattern, ctx, mime) {
  const d = ctx.date instanceof Date && !isNaN(ctx.date) ? ctx.date : new Date();
  const n = ctx.index + 1;
  const tokens = {
    '원본': baseName(ctx.fileName),
    '순번': pad(n, 2),
    '순번2': pad(n, 2),
    '순번3': pad(n, 3),
    '순번4': pad(n, 4),
    '날짜': `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`,
    '시간': `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`,
  };
  let name = (pattern || '{원본}').replace(/\{([^}]+)\}/g, (m, key) => (key in tokens ? tokens[key] : m));
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || baseName(ctx.fileName);
  // macOS hands over Korean names in NFD; NFC keeps them readable on Windows too.
  return `${name}.${extensionFor(mime)}`.normalize('NFC');
}
