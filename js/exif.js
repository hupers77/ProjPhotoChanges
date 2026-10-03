// Minimal JPEG EXIF support: reads the tags the overlays and file names need,
// and keeps the raw APP1 block so it can be copied into the resized JPEG.

const cache = new WeakMap();

// Resolves to { tags, app1 } or null (no EXIF, not a JPEG, or unreadable).
export function readExif(file) {
  if (!cache.has(file)) cache.set(file, load(file).catch(() => null));
  return cache.get(file);
}

async function load(file) {
  let buf = await file.slice(0, 256 * 1024).arrayBuffer();
  let view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
  let p = 2;
  for (;;) {
    if (p + 4 > view.byteLength) {
      if (p + 4 > file.size) return null;
      buf = await file.slice(0, p + 70 * 1024).arrayBuffer();
      view = new DataView(buf);
    }
    if (view.getUint8(p) !== 0xFF) return null;
    const marker = view.getUint8(p + 1);
    if (marker === 0xFF) { p++; continue; }           // fill byte
    if (marker === 0xDA || marker === 0xD9) return null; // image data starts: no EXIF
    const len = view.getUint16(p + 2);
    const end = p + 2 + len;
    if (marker === 0xE1) {
      if (end > view.byteLength) {
        buf = await file.slice(0, end).arrayBuffer();
        view = new DataView(buf);
      }
      // "Exif\0\0"
      if (view.getUint32(p + 4) === 0x45786966 && view.getUint16(p + 8) === 0) {
        const app1 = new Uint8Array(buf.slice(p, end)); // includes the FFE1 marker
        return { tags: parseTags(new DataView(app1.buffer)), app1 };
      }
    }
    p = end;
  }
}

// ---------- TIFF structure ----------

const APP1_TIFF = 10; // FFE1 + length(2) + "Exif\0\0"
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function tiff(v) {
  const le = v.getUint16(APP1_TIFF) === 0x4949;
  const at = (o) => APP1_TIFF + o;
  const t = {
    v, le, at,
    u16: (o) => v.getUint16(at(o), le),
    u32: (o) => v.getUint32(at(o), le),
    set16: (o, x) => v.setUint16(at(o), x, le),
    set32: (o, x) => v.setUint32(at(o), x, le),
    // [{ tag, type, count, entry, value }] where entry/value are TIFF-relative offsets.
    ifd(off) {
      const n = t.u16(off);
      const list = [];
      for (let i = 0; i < n; i++) {
        const entry = off + 2 + i * 12;
        const type = t.u16(entry + 2);
        const count = t.u32(entry + 4);
        const size = (TYPE_SIZE[type] || 1) * count;
        list.push({ tag: t.u16(entry), type, count, size, entry, value: size > 4 ? t.u32(entry + 8) : entry + 8 });
      }
      return { list, next: off + 2 + n * 12 };
    },
  };
  if (t.u16(2) !== 42) throw new Error('not TIFF');
  return t;
}

function readValue(t, e) {
  const { v, le, at } = t;
  const o = at(e.value);
  switch (e.type) {
    case 2: {
      const bytes = new Uint8Array(v.buffer, v.byteOffset + o, e.count);
      return new TextDecoder('utf-8').decode(bytes).replace(/\0[\s\S]*$/, '').trim();
    }
    case 3: case 4: case 9: {
      const vals = [];
      for (let i = 0; i < e.count; i++) {
        vals.push(e.type === 3 ? v.getUint16(o + i * 2, le) : e.type === 4 ? v.getUint32(o + i * 4, le) : v.getInt32(o + i * 4, le));
      }
      return e.count === 1 ? vals[0] : vals;
    }
    case 5: case 10: {
      const vals = [];
      for (let i = 0; i < e.count; i++) {
        const a = e.type === 5 ? v.getUint32(o + i * 8, le) : v.getInt32(o + i * 8, le);
        const b = e.type === 5 ? v.getUint32(o + i * 8 + 4, le) : v.getInt32(o + i * 8 + 4, le);
        vals.push(b ? a / b : NaN);
      }
      return e.count === 1 ? vals[0] : vals;
    }
    default: return undefined;
  }
}

const IFD0_TAGS = {
  0x010F: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0132: 'DateTime', 0x013B: 'Artist', 0x8298: 'Copyright',
  0x011A: 'XResolution', 0x011B: 'YResolution', 0x0128: 'ResolutionUnit',
};
const EXIF_TAGS = {
  0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8827: 'ISO', 0x8832: 'RecommendedExposureIndex',
  0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9204: 'ExposureBias',
  0x920A: 'FocalLength', 0xA405: 'FocalLength35', 0xA432: 'LensSpecification',
  0xA433: 'LensMake', 0xA434: 'LensModel',
};

function parseTags(view) {
  const tags = {};
  let t;
  try { t = tiff(view); } catch { return tags; }
  const collect = (off, names) => {
    for (const e of t.ifd(off).list) {
      if (names[e.tag]) {
        try { tags[names[e.tag]] = readValue(t, e); } catch { /* skip broken tag */ }
      }
    }
  };
  try {
    const ifd0 = t.u32(4);
    collect(ifd0, IFD0_TAGS);
    const exifPtr = t.ifd(ifd0).list.find(e => e.tag === 0x8769);
    if (exifPtr) collect(t.u32(exifPtr.entry + 8), EXIF_TAGS);
  } catch { /* keep what was read */ }
  return tags;
}

// Copy of the original APP1 fixed up for the resized output: pixels are
// already rotated upright, the embedded thumbnail would be stale, and GPS
// can be wiped. Offsets stay unchanged so maker notes remain valid.
export function exifForOutput(app1, { width, height, stripGps, dpi }) {
  const out = app1.slice();
  const t = tiff(new DataView(out.buffer));
  const ifd0 = t.ifd(t.u32(4));
  for (const e of ifd0.list) {
    if (e.tag === 0x0112 && e.type === 3) t.set16(e.entry + 8, 1);
    if (dpi && (e.tag === 0x011A || e.tag === 0x011B) && e.type === 5 && e.count === 1) {
      t.set32(e.value, dpi); t.set32(e.value + 4, 1);
    }
    if (dpi && e.tag === 0x0128 && e.type === 3) t.set16(e.entry + 8, 2); // inches
  }
  t.set32(ifd0.next, 0); // unlink IFD1 (thumbnail)

  const exifPtr = ifd0.list.find(e => e.tag === 0x8769);
  if (exifPtr) {
    for (const e of t.ifd(t.u32(exifPtr.entry + 8)).list) {
      const val = e.tag === 0xA002 ? width : e.tag === 0xA003 ? height : null;
      if (val == null) continue;
      if (e.type === 3 && val <= 0xFFFF) t.set16(e.entry + 8, val);
      else if (e.type === 4) t.set32(e.entry + 8, val);
    }
  }

  const gpsPtr = ifd0.list.find(e => e.tag === 0x8825);
  if (stripGps && gpsPtr) {
    const gpsOff = t.u32(gpsPtr.entry + 8);
    const gps = t.ifd(gpsOff);
    // Erase the coordinates themselves, not just the pointers to them.
    for (const e of gps.list) if (e.size > 4) out.fill(0, t.at(e.value), t.at(e.value) + e.size);
    out.fill(0, t.at(gpsOff), t.at(gps.next) + 4);
  }
  return out;
}

// Inserts an APP1 block right after SOI/JFIF of a canvas-encoded JPEG.
export async function insertExif(jpegBlob, app1) {
  const buf = new Uint8Array(await jpegBlob.arrayBuffer());
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return jpegBlob;
  let p = 2;
  if (buf[2] === 0xFF && buf[3] === 0xE0) p = 4 + ((buf[4] << 8) | buf[5]);
  return new Blob([buf.subarray(0, p), app1, buf.subarray(p)], { type: 'image/jpeg' });
}

// Pixels per inch the original declares (EXIF first, then JFIF), or null.
export async function sourceDpi(file, exif) {
  const t = exif?.tags;
  if (t && num(t.XResolution) && t.XResolution > 1) {
    return Math.round(t.ResolutionUnit === 3 ? t.XResolution * 2.54 : t.XResolution);
  }
  try {
    const b = new Uint8Array(await file.slice(0, 20).arrayBuffer());
    // FFD8 FFE0 len "JFIF\0" ver(2) units Xdensity Ydensity
    if (b[2] === 0xFF && b[3] === 0xE0 && b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
      const units = b[13], x = (b[14] << 8) | b[15];
      if (units === 1 && x > 1) return x;
      if (units === 2 && x > 1) return Math.round(x * 2.54);
    }
  } catch { /* ignore */ }
  return null;
}

// ---------- values for overlays and file names ----------

function parseExifDate(s) {
  const m = typeof s === 'string' && s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) || +m[1] < 1900 ? null : d;
}

export function captureDate(tags) {
  if (!tags) return null;
  return parseExifDate(tags.DateTimeOriginal) || parseExifDate(tags.DateTimeDigitized) || parseExifDate(tags.DateTime);
}

// Shooting date when the camera recorded one, else the file's modified date.
export function photoDate(file, exif) {
  return captureDate(exif?.tags) || new Date(file.lastModified);
}

const pad2 = (n) => String(n).padStart(2, '0');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const trimNum = (x, digits = 1) => String(Number(x.toFixed(digits)));

function camera(tags) {
  const make = (tags.Make || '').trim();
  const model = (tags.Model || '').trim();
  if (!model) return make;
  const brand = make.split(/\s+/)[0];
  // "Canon" + "Canon EOS R5" -> "Canon EOS R5"; "SONY" + "ILCE-7M3" -> "SONY ILCE-7M3"
  if (!brand || model.toLowerCase().startsWith(brand.toLowerCase())) return model;
  return `${brand} ${model}`;
}

// "24-70mm" (withAperture: "24-70mm f/2.8"), from LensSpecification or the lens name.
function lensRange(tags, withAperture) {
  let fmin, fmax, amin;
  const spec = tags.LensSpecification;
  if (Array.isArray(spec) && num(spec[0])) [fmin, fmax, amin] = spec;
  else {
    const name = `${tags.LensModel || ''}`;
    const m = name.match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*mm/i);
    if (!m) return '';
    fmin = +m[1]; fmax = m[2] ? +m[2] : fmin;
    const a = name.match(/(?:f\/?|1:)\s*(\d+(?:\.\d+)?)/i);
    amin = a ? +a[1] : null;
  }
  const focal = fmin === fmax || !num(fmax) ? `${trimNum(fmin, 0)}mm` : `${trimNum(fmin, 0)}-${trimNum(fmax, 0)}mm`;
  return withAperture && num(amin) ? `${focal} f/${trimNum(amin)}` : focal;
}

function lens(tags) {
  const model = (tags.LensModel || '').trim();
  if (model && !/^-+$/.test(model)) return model;
  const spec = tags.LensSpecification;
  if (Array.isArray(spec) && num(spec[0])) {
    const [fmin, fmax, amin] = spec;
    const focal = fmin === fmax || !num(fmax) ? `${trimNum(fmin, 0)}mm` : `${trimNum(fmin, 0)}-${trimNum(fmax, 0)}mm`;
    return num(amin) ? `${focal} f/${trimNum(amin)}` : focal;
  }
  return '';
}

function shutter(t) {
  if (!num(t) || t <= 0) return '';
  if (t < 0.4) return `1/${Math.round(1 / t)}s`;
  return `${trimNum(t)}s`;
}

// Token name -> display text. Missing values are '' so templates can drop them.
export function exifTokens(tags, file) {
  tags = tags || {};
  const d = captureDate(tags);
  const iso = num(tags.ISO) === 65535 && num(tags.RecommendedExposureIndex) ? tags.RecommendedExposureIndex
    : Array.isArray(tags.ISO) ? tags.ISO[0] : tags.ISO;
  const bias = num(tags.ExposureBias);
  const name = file?.name || '';
  const dot = name.lastIndexOf('.');
  return {
    '카메라': camera(tags),
    '제조사': (tags.Make || '').trim(),
    '모델': (tags.Model || '').trim(),
    '렌즈': lens(tags),
    '렌즈mm': lensRange(tags, false),
    '렌즈mm조리개': lensRange(tags, true),
    '초점거리': num(tags.FocalLength) ? `${trimNum(tags.FocalLength)}mm` : '',
    '35mm환산': num(tags.FocalLength35) ? `${tags.FocalLength35}mm` : '',
    '조리개': num(tags.FNumber) ? `f/${trimNum(tags.FNumber)}` : '',
    '셔터': shutter(tags.ExposureTime),
    'ISO': num(iso) ? `ISO ${iso}` : '',
    '노출보정': bias ? `${bias > 0 ? '+' : ''}${trimNum(bias)}EV` : '',
    '촬영일': d ? `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}` : '',
    '촬영시각': d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '',
    '촬영일시': d ? `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '',
    '작가': (tags.Artist || '').trim(),
    '저작권': (tags.Copyright || '').trim(),
    '파일명': (dot > 0 ? name.slice(0, dot) : name).normalize('NFC'),
  };
}

export const TOKEN_NAMES = ['카메라', '렌즈', '렌즈mm', '렌즈mm조리개', '초점거리', '조리개', '셔터', 'ISO', '노출보정', '촬영일', '촬영시각', '촬영일시', '작가', '저작권', '파일명', '35mm환산', '제조사', '모델'];
