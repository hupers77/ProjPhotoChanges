// Named presets: a full copy of the settings plus the signature image, kept in
// this browser and exportable as a JSON file (to move between browsers or
// from localhost to the hosted site, which have separate storage).

import { normalizeSettings } from './settings.js';

const STORAGE_KEY = 'photoworks-web:presets:v1';
const FILE_KIND = 'photoworks-web-presets';

/** @typedef {{ name: string, settings: object, signatureImage: string|null, savedAt: string }} Preset */

/** @returns {Preset[]} */
export function listPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(list) ? list.filter(p => p && typeof p.name === 'string') : [];
  } catch {
    return [];
  }
}

// Throws if the browser refuses (usually a large signature image over quota).
function store(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function getPreset(name) {
  return listPresets().find(p => p.name === name) || null;
}

export function savePreset(name, settings, signatureImage) {
  const list = listPresets().filter(p => p.name !== name);
  const preset = {
    name,
    settings: structuredClone(settings),
    signatureImage: signatureImage || null,
    savedAt: new Date().toISOString(),
  };
  const old = listPresets().findIndex(p => p.name === name);
  if (old >= 0) list.splice(old, 0, preset); else list.push(preset);
  store(list);
  return preset;
}

export function deletePreset(name) {
  store(listPresets().filter(p => p.name !== name));
}

// Settings from a preset, filled up with defaults for keys added since it was saved.
export function presetSettings(preset) {
  return normalizeSettings(preset.settings);
}

export function exportPresetsBlob(presets = listPresets()) {
  const data = { kind: FILE_KIND, version: 1, exportedAt: new Date().toISOString(), presets };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

// Adds presets from an exported file; same names are replaced. Returns the count.
export async function importPresetsFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('JSON 파일이 아닙니다.'); }
  const incoming = data?.kind === FILE_KIND && Array.isArray(data.presets) ? data.presets : null;
  if (!incoming) throw new Error('포토웍스 웹에서 내보낸 프리셋 파일이 아닙니다.');
  const valid = incoming.filter(p => p && typeof p.name === 'string' && p.name.trim() && p.settings);
  const list = listPresets();
  for (const p of valid) {
    const preset = {
      name: p.name.trim(),
      settings: normalizeSettings(p.settings),
      signatureImage: typeof p.signatureImage === 'string' && p.signatureImage.startsWith('data:image/') ? p.signatureImage : null,
      savedAt: typeof p.savedAt === 'string' ? p.savedAt : new Date().toISOString(),
    };
    const i = list.findIndex(x => x.name === preset.name);
    if (i >= 0) list[i] = preset; else list.push(preset);
  }
  store(list);
  return valid.length;
}
