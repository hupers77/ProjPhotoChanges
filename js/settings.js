// All user-adjustable options live in one plain object so later steps
// (signature/EXIF overlay, presets) can add sections and serialize it whole.

const STORAGE_KEY = 'photoworks-web:settings:v1';

export const DEFAULT_SETTINGS = {
  resize: {
    mode: 'long',        // long | short | width | height | box | percent | none
    longEdge: 1920,
    shortEdge: 1080,
    width: 1920,
    height: 1080,
    boxW: 1920,
    boxH: 1920,
    percent: 50,
    noEnlarge: true,
  },
  output: {
    format: 'image/jpeg', // same | image/jpeg | image/png | image/webp
    quality: 92,          // 50-100, used for JPEG/WebP
    namePattern: '{원본}_resized',
    saveTarget: 'folder', // folder | download
    keepExif: true,       // copy the original EXIF into JPEG outputs
    stripGps: true,       // ...minus the GPS location
  },
  // position: t|m|b + l|c|r. size/margin: % of the photo's shorter side.
  signature: {
    enabled: false,
    kind: 'text',         // text | image
    text: '© 내 이름',
    imageWidth: 20,       // image: % of the photo width
    position: 'br',
    size: 4,
    margin: 3,
    font: 'sans',         // sans | serif | mono
    bold: true,
    color: '#ffffff',
    opacity: 85,
    effect: 'shadow',     // none | shadow | outline | box
  },
  exifOverlay: {
    enabled: false,
    template: '{카메라} · {렌즈}\n{초점거리} · {조리개} · {셔터} · {ISO} · {촬영일시}',
    position: 'bl',
    size: 2.2,
    margin: 3,
    font: 'sans',
    bold: false,
    color: '#ffffff',
    opacity: 90,
    effect: 'shadow',
  },
};

export function cloneDefaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

// Deep-merge saved values over defaults so new keys from later versions get defaults.
function merge(base, saved) {
  if (!saved || typeof saved !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (!(key in saved)) continue;
    const b = base[key];
    const s = saved[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) merge(b, s);
    else if (typeof s === typeof b) base[key] = s;
  }
  return base;
}

// A full settings object built from defaults plus whatever valid values
// \`saved\` carries (used for presets and imported files too).
export function normalizeSettings(saved) {
  return merge(cloneDefaults(), saved);
}

// Overwrite \`target\` in place so modules holding a reference see the change.
export function assignSettings(target, source) {
  for (const group of Object.keys(DEFAULT_SETTINGS)) Object.assign(target[group], source[group]);
  return target;
}

export function loadSettings() {
  const settings = cloneDefaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) merge(settings, JSON.parse(raw));
  } catch { /* storage unavailable: use defaults */ }
  return settings;
}

export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
