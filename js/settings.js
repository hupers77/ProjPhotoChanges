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
  },
  // Step 2 adds: signature: {...}, exifOverlay: {...}
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
