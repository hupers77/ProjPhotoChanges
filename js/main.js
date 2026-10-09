import { loadSettings, saveSettings, assignSettings, cloneDefaults } from './settings.js';
import { buildFileName } from './filename.js';
import { processFile, outputMime, registerOverlay, loadPreviewBase, renderPreview, targetSize } from './pipeline.js';
import { detectInstalledFonts, canListLocalFonts, listLocalFonts, localFontsGranted } from './fonts.js';
import { canPickFolder, createSaver } from './exporter.js';
import { readExif, exifTokens, photoDate, TOKEN_NAMES } from './exif.js';
import { drawOverlays, setSignatureImage, getSignatureImage } from './overlay.js';
import { createPool } from './pool.js';
import { listPresets, getPreset, savePreset, deletePreset, presetSettings, exportPresetsBlob, importPresetsFile } from './presets.js';

registerOverlay(drawOverlays);

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
if (!canPickFolder && settings.output.saveTarget === 'folder') settings.output.saveTarget = 'download';

/** @type {{id:number, file:File, el:HTMLElement, width?:number, height?:number}[]} */
const items = [];
let nextId = 1;
let running = false;
let cancelRequested = false;
let pool = null;          // background workers, once ready (null = do it on the page)

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const isImage = (f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name);

// ---------- settings form <-> settings object ----------

const bindings = [
  ['resize-mode', 'resize', 'mode'],
  ['long-edge', 'resize', 'longEdge', Number],
  ['short-edge', 'resize', 'shortEdge', Number],
  ['width', 'resize', 'width', Number],
  ['height', 'resize', 'height', Number],
  ['box-w', 'resize', 'boxW', Number],
  ['box-h', 'resize', 'boxH', Number],
  ['percent', 'resize', 'percent', Number],
  ['no-enlarge', 'resize', 'noEnlarge'],
  ['format', 'output', 'format'],
  ['quality', 'output', 'quality', Number],
  ['name-pattern', 'output', 'namePattern'],
  ['keep-exif', 'output', 'keepExif'],
  ['strip-gps', 'output', 'stripGps'],
  ['dpi', 'output', 'dpi'],
  ['fx-rotate', 'effects', 'rotate', Number],
  ['fx-autolevel', 'effects', 'autoLevel'],
  ['fx-sharpen', 'effects', 'sharpen', Number],
  ['sig-text', 'signature', 'text'],
  ['sig-image-width', 'signature', 'imageWidth', Number],
  ['exif-template', 'exifOverlay', 'template'],
];
// Signature and EXIF text share the same style controls, prefixed sig- / exif-.
const OVERLAY_GROUPS = [['sig', 'signature'], ['exif', 'exifOverlay']];
for (const [p, group] of OVERLAY_GROUPS) {
  bindings.push(
    [`${p}-enabled`, group, 'enabled'],
    [`${p}-size`, group, 'size', Number],
    [`${p}-font`, group, 'font'],
    [`${p}-bold`, group, 'bold'],
    [`${p}-color`, group, 'color'],
    [`${p}-effect`, group, 'effect'],
    [`${p}-opacity`, group, 'opacity', Number],
    [`${p}-margin`, group, 'margin', Number],
  );
}

const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const POSITION_LABEL = { t: '위', m: '가운데', b: '아래', l: '왼쪽', c: '가운데', r: '오른쪽' };
function buildPositionGrids() {
  for (const [p, group] of OVERLAY_GROUPS) {
    const grid = $(`${p}-position`);
    for (const pos of POSITIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.pos = pos;
      b.setAttribute('role', 'radio');
      b.title = pos === 'mc' ? '정가운데' : `${POSITION_LABEL[pos[0]]} ${POSITION_LABEL[pos[1]]}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        settings[group].position = pos;
        saveSettings(settings);
        refreshFormState();
      });
      grid.appendChild(b);
    }
  }
}

// Token chips insert "{토큰}" at the cursor of their textarea.
function buildChips() {
  document.querySelectorAll('.chips').forEach(box => {
    const target = $(box.dataset.target);
    for (const name of TOKEN_NAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.title = `{${name}} 넣기`;
      b.addEventListener('click', () => {
        const tok = `{${name}}`;
        const { selectionStart: a, selectionEnd: z, value } = target;
        target.value = value.slice(0, a) + tok + value.slice(z);
        target.focus();
        target.setSelectionRange(a + tok.length, a + tok.length);
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      box.appendChild(b);
    }
  });
}

function fillForm() {
  for (const [id, group, key] of bindings) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = settings[group][key];
    else el.value = settings[group][key];
  }
  $('sig-kind-text').checked = settings.signature.kind !== 'image';
  $('sig-kind-image').checked = settings.signature.kind === 'image';
  $('save-folder').checked = settings.output.saveTarget === 'folder';
  $('save-download').checked = settings.output.saveTarget === 'download';
  if (!canPickFolder) $('save-folder').disabled = true;
}

function readForm() {
  for (const [id, group, key, cast] of bindings) {
    const el = $(id);
    if (el.type === 'checkbox') settings[group][key] = el.checked;
    else if (cast === Number) {
      const v = Number(el.value);
      if (Number.isFinite(v) && (el.min === '0' || 'zero' in el.dataset ? v >= 0 : v > 0)) settings[group][key] = v;
    } else settings[group][key] = el.value;
  }
  settings.signature.kind = $('sig-kind-image').checked ? 'image' : 'text';
  settings.output.saveTarget = $('save-folder').checked ? 'folder' : 'download';
}

function refreshFormState() {
  const mode = settings.resize.mode;
  document.querySelectorAll('[data-for]').forEach(el => { el.hidden = el.dataset.for !== mode; });
  $('no-enlarge').closest('label').hidden = mode === 'none';

  const fmt = settings.output.format;
  const isIcon = fmt === 'image/x-icon';
  $('quality-row').hidden = fmt === 'image/png' || isIcon;
  $('output-extra').hidden = isIcon;
  $('icon-hint').hidden = !isIcon;
  $('quality-out').textContent = settings.output.quality;
  $('strip-gps').disabled = !settings.output.keepExif;
  $('fx-sharpen-out').textContent = settings.effects.sharpen > 0 ? settings.effects.sharpen : '끔';

  const sample = items[0];
  const mime = sample ? outputMime(sample.file, fmt) : (fmt === 'same' ? 'image/jpeg' : fmt);
  $('exif-keep-hint').hidden = !settings.output.keepExif || mime === 'image/jpeg';
  $('dpi-hint').hidden = settings.output.dpi === 'keep' || mime !== 'image/webp';
  $('name-example').textContent = buildFileName(settings.output.namePattern, {
    fileName: sample?.file.name || 'IMG_0001.JPG', index: 0, date: sample ? photoDate(sample.file, sample.exif) : new Date(),
  }, mime);

  const sigKind = settings.signature.kind;
  document.querySelectorAll('#sig-sub [data-kind-text]').forEach(el => { el.hidden = sigKind !== 'text'; });
  document.querySelectorAll('#sig-sub [data-kind-image]').forEach(el => { el.hidden = sigKind !== 'image'; });
  for (const [p, group] of OVERLAY_GROUPS) {
    $(`${p}-sub`).hidden = !settings[group].enabled;
    $(`${p}-opacity-out`).textContent = `${settings[group].opacity}%`;
    $(`${p}-position`).querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-checked', String(b.dataset.pos === settings[group].position));
    });
  }
  const hasSig = !!getSignatureImage();
  $('sig-image-thumb').hidden = !hasSig;
  $('sig-image-clear').hidden = !hasSig;
  $('sig-image-pick').textContent = hasSig ? '다른 이미지' : '이미지 고르기';

  $('save-hint').textContent = canPickFolder
    ? (settings.output.saveTarget === 'folder'
        ? '변환할 때 저장할 폴더를 한 번 고르면 모든 사진이 그 안에 개별 파일로 저장됩니다. 같은 이름이 있으면 덮어쓰지 않고 (1), (2)를 붙입니다.'
        : '브라우저가 "여러 파일 다운로드 허용"을 물으면 허용을 눌러 주세요.')
    : '이 브라우저는 폴더 저장을 지원하지 않아 한 장씩 다운로드됩니다. 처음에 "여러 파일 다운로드 허용"을 물으면 허용을 눌러 주세요. 폴더에 바로 저장하려면 Chrome이나 Edge를 쓰세요.';

  for (const it of items) updateDims(it);
  schedulePreview();
}

function onSettingsChange() {
  readForm();
  saveSettings(settings);
  refreshFormState();
}

// ---------- file list ----------

function updateCount() {
  $('file-count').textContent = `사진 ${items.length}장`;
  updatePreviewNav();
  $('clear-all').disabled = running || items.length === 0;
  $('run').disabled = $('run-top').disabled = running || items.length === 0;
}

function updateDims(it) {
  const el = it.el.querySelector('.dims');
  if (!it.width) { el.textContent = '크기 읽는 중…'; return; }
  if (settings.output.format === 'image/x-icon') { el.textContent = `${it.width}×${it.height} → 아이콘 32·16`; return; }
  const t = targetSize(it.width, it.height, settings);
  el.textContent = `${it.width}×${it.height} → ${t.width}×${t.height}`;
}

function setStatus(it, text, cls = '') {
  const s = it.el.querySelector('.status');
  s.textContent = text;
  s.className = `status ${cls}`;
}

function addFiles(files) {
  const fresh = files.filter(isImage);
  for (const file of fresh) {
    const it = { id: nextId++, file, el: document.createElement('li') };
    it.el.className = 'file-item';
    it.el.innerHTML = `<img alt=""><button type="button" class="remove" title="빼기" aria-label="빼기">×</button>
      <div class="meta"><div class="name"></div><div class="dims"></div><div class="status"></div></div>`;
    it.el.querySelector('.name').textContent = file.name;
    it.el.querySelector('.name').title = file.name;
    it.el.querySelector('.remove').addEventListener('click', (e) => { e.stopPropagation(); removeItem(it); });
    it.el.addEventListener('click', () => selectPreview(it));
    $('file-list').appendChild(it.el);
    items.push(it);
    updateDims(it);
    thumbQueue.push(it);
    readExif(file).then(exif => {
      it.exif = exif;
      if (it === items[0]) refreshFormState();
    });
  }
  if (!previewItem && items.length) selectPreview(items[0]);
  pumpThumbs();
  updateCount();
  refreshFormState();
}

function removeItem(it) {
  if (running) return;
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  const img = it.el.querySelector('img');
  if (img.src) URL.revokeObjectURL(img.src);
  it.el.remove();
  it.removed = true;
  if (previewItem === it) selectPreview(items[Math.min(i, items.length - 1)] || null);
  updateCount();
  refreshFormState();
}

// Thumbnails: decode in the background (2 at a time) to get real
// orientation-corrected dimensions and a small preview image.
const thumbQueue = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < (pool ? pool.size : 2) && thumbQueue.length) {
    const it = thumbQueue.shift();
    if (it.removed) continue;
    thumbActive++;
    makeThumb(it).finally(() => { thumbActive--; pumpThumbs(); });
  }
}
async function makeThumb(it) {
  const img = it.el.querySelector('img');
  if (pool) {
    try {
      const t = await pool.run('thumb', { file: it.file, maxEdge: 320 }, 'low');
      it.width = t.width; it.height = t.height;
      if (!it.removed) { img.src = URL.createObjectURL(t.blob); updateDims(it); }
      return;
    } catch { /* fall back to the page below */ }
  }
  try {
    const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image' });
    it.width = bmp.width; it.height = bmp.height;
    const s = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    if (!it.removed && blob) img.src = URL.createObjectURL(blob);
  } catch {
    // Fallback for formats createImageBitmap rejects but <img> can show (e.g. HEIC on Safari).
    const url = URL.createObjectURL(it.file);
    img.onload = () => { it.width = img.naturalWidth; it.height = img.naturalHeight; updateDims(it); };
    img.onerror = () => setStatus(it, '이 브라우저에서 열 수 없는 형식', 'error');
    img.src = url;
  }
  if (!it.removed) updateDims(it);
}

// ---------- preview ----------

let previewItem = null;
let previewBase = null;   // decoded, reduced copy of previewItem
let previewSeq = 0;
let previewPending = false;

function updatePreviewNav() {
  const i = items.indexOf(previewItem);
  $('preview-pos').textContent = i >= 0 ? `${i + 1} / ${items.length}` : '';
  $('prev-photo').disabled = i <= 0;
  $('next-photo').disabled = i < 0 || i >= items.length - 1;
}

function stepPreview(delta) {
  const i = items.indexOf(previewItem);
  const next = items[i + delta];
  if (!next) return;
  selectPreview(next);
  next.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function selectPreview(it) {
  previewItem = it;
  previewBase = null;
  items.forEach(x => x.el.classList.toggle('selected', x === it));
  $('preview').hidden = !it;
  updatePreviewNav();
  if (!it) return;
  const seq = ++previewSeq;
  $('preview-info').textContent = '불러오는 중…';
  try {
    const pb = await loadPreviewBase(it.file);
    if (seq !== previewSeq) return;
    previewBase = pb;
    schedulePreview();
  } catch {
    if (seq === previewSeq) $('preview-info').textContent = '이 브라우저에서 미리 볼 수 없는 형식';
  }
}

function schedulePreview() {
  if (previewPending || !previewBase) return;
  previewPending = true;
  requestAnimationFrame(async () => {
    previewPending = false;
    const pb = previewBase;
    if (!pb) return;
    const index = Math.max(0, items.indexOf(previewItem));
    const { width, height, icon } = await renderPreview($('preview-canvas'), pb, index, settings);
    const t = exifTokens(pb.exif?.tags, pb.file);
    const bits = [icon ? '아이콘 32×32·16×16 (32px 확대 보기)' : `저장 크기 ${width}×${height}`, t['카메라'], t['촬영일시']].filter(Boolean);
    if (!pb.exif) bits.push('EXIF 없음');
    $('preview-info').textContent = bits.join(' · ');
  });
}

// ---------- signature image ----------

const SIG_IMAGE_KEY = 'photoworks-web:signature-image:v1';
let signatureDataUrl = null; // what presets store

const dataUrlToBlob = async (url) => (await fetch(url)).blob();

async function useSignatureImage(blob, remember) {
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch {
    alert('이 이미지를 열 수 없습니다. PNG나 JPEG 파일을 골라 주세요.');
    return;
  }
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
  setSignatureImage(bmp);
  signatureDataUrl = dataUrl;
  pool?.setSignature(blob);
  $('sig-image-thumb').src = dataUrl;
  let hint = `${bmp.width}×${bmp.height} 이미지. 배경이 투명한 PNG가 가장 잘 어울립니다.`;
  if (remember) {
    try { localStorage.setItem(SIG_IMAGE_KEY, dataUrl); } catch {
      hint += ' 파일이 커서 브라우저에 기억하지 못했어요. 다음에 다시 골라 주세요.';
    }
  }
  $('sig-image-hint').textContent = hint;
  refreshFormState();
}

$('sig-image-pick').addEventListener('click', () => $('sig-image-input').click());
$('sig-image-input').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) useSignatureImage(f, true);
});
$('sig-image-clear').addEventListener('click', () => {
  setSignatureImage(null);
  signatureDataUrl = null;
  pool?.setSignature(null);
  try { localStorage.removeItem(SIG_IMAGE_KEY); } catch { /* ignore */ }
  $('sig-image-thumb').removeAttribute('src');
  $('sig-image-hint').textContent = '배경이 투명한 PNG가 가장 잘 어울립니다.';
  refreshFormState();
});

async function restoreSignatureImage() {
  let dataUrl = null;
  try { dataUrl = localStorage.getItem(SIG_IMAGE_KEY); } catch { /* ignore */ }
  if (!dataUrl) return;
  try { await useSignatureImage(await dataUrlToBlob(dataUrl), false); } catch { /* ignore */ }
}

// ---------- intake: drag & drop, pickers ----------

async function entriesToFiles(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((res, rej) => entry.file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await entriesToFiles(e, out);
    } while (batch.length);
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

async function handleDrop(e) {
  e.preventDefault();
  $('dropzone').classList.remove('over');
  if (running) return;
  const dtItems = [...(e.dataTransfer.items || [])];
  const entries = dtItems.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) {
    const files = [];
    for (const en of entries) await entriesToFiles(en, files);
    addFiles(files.sort(byName));
  } else {
    addFiles([...e.dataTransfer.files]);
  }
}

const dz = $('dropzone');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('over'); }));
dz.addEventListener('dragleave', e => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('over'); });
dz.addEventListener('drop', handleDrop);
// Dropping outside the zone shouldn't navigate away from the app.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { if (!dz.contains(e.target)) handleDrop(e); });

$('pick-files').addEventListener('click', () => $('file-input').click());
$('pick-folder').addEventListener('click', () => $('folder-input').click());
dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });
for (const id of ['file-input', 'folder-input']) {
  $(id).addEventListener('change', e => { addFiles([...e.target.files].sort(byName)); e.target.value = ''; });
}
$('clear-all').addEventListener('click', () => { [...items].forEach(removeItem); });

// ---------- batch run ----------

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(n / 1024))}KB`;
}

function setProgress(done, total, failed) {
  $('progress').hidden = false;
  $('progress-bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progress-text').textContent = `${done} / ${total}장 처리${failed ? ` · 실패 ${failed}장` : ''}`;
  $('top-progress').textContent = `${done} / ${total}장`;
}

async function run() {
  readForm();
  saveSettings(settings);
  if (settings.signature.enabled && settings.signature.kind === 'image' && !getSignatureImage()
      && !confirm('서명 이미지를 아직 고르지 않았습니다. 서명 없이 저장할까요?')) return;
  let saver;
  try {
    saver = await createSaver(settings.output.saveTarget);
  } catch (err) {
    if (err?.name !== 'AbortError') alert(`저장 폴더를 열 수 없습니다: ${err?.message || err}`);
    return;
  }

  running = true; cancelRequested = false;
  $('cancel').hidden = $('cancel-top').hidden = false;
  setPresetButtons();
  updateCount();
  const startedAt = performance.now();
  const queue = [...items];
  const total = queue.length;
  let done = 0, failed = 0, next = 0, inBytes = 0, outBytes = 0;
  queue.forEach(it => setStatus(it, '대기'));
  setProgress(0, total, 0);

  // Background workers if available, else 2 at a time on the page.
  // A photo a worker can't handle (e.g. HEIC that only <img> decodes) is retried on the page.
  const lanes = pool ? pool.size : 2;
  const opts = structuredClone(settings);
  const convert = (it, index) => (pool
    ? pool.run('process', { file: it.file, index, settings: opts }).catch(() => processFile(it.file, index, opts))
    : processFile(it.file, index, opts));

  // Encode several photos at once, but write them strictly in list order so
  // downloads and duplicate-name checks happen one by one, first photo first.
  const savedTurn = [];
  const turn = (i) => savedTurn[i] || (savedTurn[i] = Promise.resolve());
  async function worker() {
    while (!cancelRequested && next < total) {
      const index = next++;
      const it = queue[index];
      let release;
      savedTurn[index + 1] = new Promise(r => { release = r; });
      setStatus(it, '변환 중…');
      try {
        const out = await convert(it, index);
        await turn(index);
        const finalName = await saver.save(out.name, out.blob);
        inBytes += it.file.size; outBytes += out.blob.size;
        setStatus(it, `저장됨: ${finalName} (${formatBytes(it.file.size)} → ${formatBytes(out.blob.size)})`, 'done');
      } catch (err) {
        failed++;
        setStatus(it, `실패: ${err?.message || err}`, 'error');
      } finally {
        await turn(index);
        release();
      }
      done++;
      setProgress(done, total, failed);
    }
  }
  await Promise.all(Array.from({ length: lanes }, worker));
  const secs = ((performance.now() - startedAt) / 1000).toFixed(1);

  if (cancelRequested) {
    queue.slice(next).forEach(it => setStatus(it, '중지됨'));
    $('progress-text').textContent += ' · 중지됨';
    $('top-progress').textContent = '중지됨';
  } else {
    $('progress-text').textContent = `완료: ${total - failed}장 저장${failed ? `, ${failed}장 실패` : ''} (${secs}초)`;
    if (outBytes) {
      const pct = Math.round((1 - outBytes / inBytes) * 100);
      const change = pct >= 0 ? `${pct}% 줄어듦` : `${-pct}% 늘어남`;
      $('progress-text').innerHTML += `<br><span class="summary">용량: 원본 ${formatBytes(inBytes)} → ${formatBytes(outBytes)} (${change})</span>`;
    }
    $('top-progress').textContent = `완료 ${total - failed}장${failed ? ` · 실패 ${failed}장` : ''}`;
  }
  running = false;
  $('cancel').hidden = $('cancel-top').hidden = true;
  setPresetButtons();
  updateCount();
}

for (const id of ['run', 'run-top']) $(id).addEventListener('click', run);
for (const id of ['cancel', 'cancel-top']) $(id).addEventListener('click', () => { cancelRequested = true; });

// ---------- fonts ----------

let installedFonts = [];
let localFonts = [];
const BASE_FONTS = [['sans', '고딕'], ['serif', '명조'], ['mono', '고정폭']];

function fillFontSelects() {
  const local = localFonts.filter(f => !installedFonts.includes(f));
  for (const [p, group] of OVERLAY_GROUPS) {
    const sel = $(`${p}-font`);
    sel.innerHTML = '';
    const add = (label, names) => {
      if (!names.length) return;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const n of names) {
        const [value, text] = Array.isArray(n) ? n : [n, n];
        const o = new Option(text, value);
        if (!Array.isArray(n)) o.style.fontFamily = `"${n}"`;
        g.appendChild(o);
      }
      sel.appendChild(g);
    };
    add('기본', BASE_FONTS);
    add('자주 쓰는 글꼴', installedFonts);
    add('내 컴퓨터 글꼴', local);
    const cur = settings[group].font;
    // A preset from another computer may name a font this one lacks.
    if (![...sel.options].some(o => o.value === cur)) add('저장된 설정의 글꼴', [cur]);
    sel.value = cur;
  }
  document.querySelectorAll('[data-load-fonts]').forEach(b => {
    b.hidden = !canListLocalFonts || localFonts.length > 0;
  });
}

async function loadLocalFonts() {
  try {
    localFonts = await listLocalFonts();
    fillFontSelects();
  } catch {
    alert('글꼴 목록을 가져오지 못했습니다. 브라우저 주소창 왼쪽의 사이트 설정에서 "글꼴" 권한을 허용해 주세요.');
  }
}

document.querySelectorAll('[data-load-fonts]').forEach(b => b.addEventListener('click', loadLocalFonts));

// ---------- keyboard ----------

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!$('run').disabled) run();
    return;
  }
  if (e.key === 'Escape' && running) { cancelRequested = true; return; }
  const t = e.target;
  if ($('donate').open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && previewItem && !running) { e.preventDefault(); removeItem(previewItem); }
});
$('prev-photo').addEventListener('click', () => stepPreview(-1));
$('next-photo').addEventListener('click', () => stepPreview(1));

// ---------- install as app (PWA) ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('install-app').hidden = false;
});
$('install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  $('install-app').hidden = true;
});
window.addEventListener('appinstalled', () => { $('install-app').hidden = true; });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* works without offline support */ });
}

// ---------- donation ----------

// Kakao Pay's link only opens on phones; on a computer the QR code is the way in.
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS
$('kakao-pay-link').hidden = !isMobile;
$('kakao-desktop-hint').hidden = isMobile;
if (isMobile) $('kakao-hint').textContent = '위 버튼을 누르면 카카오페이 송금 화면이 열립니다. 다른 휴대폰으로는 QR 코드를 찍어도 됩니다.';
$('kakao-share').hidden = !navigator.share;

function selectDonateTab(which) {
  for (const k of ['kakao', 'github']) {
    $(`tab-${k}`).setAttribute('aria-selected', String(k === which));
    $(`panel-${k}`).hidden = k !== which;
  }
}
$('tab-kakao').addEventListener('click', () => selectDonateTab('kakao'));
$('tab-github').addEventListener('click', () => selectDonateTab('github'));
$('donate-open').addEventListener('click', () => { selectDonateTab('kakao'); $('donate').showModal(); });
$('donate').addEventListener('click', (e) => { if (e.target === $('donate')) $('donate').close(); }); // backdrop
$('kakao-copy').addEventListener('click', async () => {
  const url = $('kakao-url').value;
  try { await navigator.clipboard.writeText(url); }
  catch { $('kakao-url').select(); document.execCommand('copy'); }
  $('kakao-copy').textContent = '복사됨';
  setTimeout(() => { $('kakao-copy').textContent = '주소 복사'; }, 1500);
});
$('kakao-share').addEventListener('click', () => {
  navigator.share({ title: '포토웍스 웹 후원 (카카오페이)', url: $('kakao-url').value }).catch(() => {});
});

// ---------- presets ----------

const COMPACT_KEY = 'photoworks-web:compact:v1';
function setCompact(on) {
  document.querySelector('.settings-pane').classList.toggle('compact', on);
  $('compact-toggle').textContent = on ? '설명 보기' : '간단히 보기';
  $('compact-toggle').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(COMPACT_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
$('compact-toggle').addEventListener('click', () => {
  setCompact(!document.querySelector('.settings-pane').classList.contains('compact'));
});
try { setCompact(localStorage.getItem(COMPACT_KEY) === '1'); } catch { setCompact(false); }

let currentPreset = '';

function fillPresetSelect() {
  const sel = $('preset-select');
  sel.innerHTML = '';
  const first = new Option(listPresets().length ? '프리셋 고르기…' : '저장된 프리셋 없음', '');
  sel.add(first);
  for (const p of listPresets()) sel.add(new Option(p.name, p.name));
  sel.value = getPreset(currentPreset) ? currentPreset : '';
  setPresetButtons();
}

function setPresetButtons() {
  const has = !!$('preset-select').value;
  $('preset-delete').disabled = running || !has;
  $('preset-select').disabled = running;
  $('preset-save').disabled = running;
  $('preset-reset').disabled = running;
  $('preset-import').disabled = running;
  $('preset-export').disabled = !listPresets().length;
}

function presetHint(text) { $('preset-hint').textContent = text; }

async function applySettings(next, sigDataUrl) {
  assignSettings(settings, next);
  if (!canPickFolder && settings.output.saveTarget === 'folder') settings.output.saveTarget = 'download';
  saveSettings(settings);
  fillFontSelects();
  fillForm();
  refreshFormState();
  if (sigDataUrl) {
    try { await useSignatureImage(await dataUrlToBlob(sigDataUrl), true); } catch { /* keep the current image */ }
  }
}

$('preset-select').addEventListener('change', async (e) => {
  e.stopPropagation();
  const p = getPreset(e.target.value);
  setPresetButtons();
  if (!p) return;
  currentPreset = p.name;
  await applySettings(presetSettings(p), p.signatureImage);
  presetHint(`"${p.name}" 프리셋을 적용했습니다.`);
});

$('preset-save').addEventListener('click', () => {
  readForm();
  const name = prompt('프리셋 이름', currentPreset || '')?.trim();
  if (!name) return;
  if (getPreset(name) && !confirm(`"${name}" 프리셋이 이미 있습니다. 지금 설정으로 덮어쓸까요?`)) return;
  const withImage = settings.signature.kind === 'image' ? signatureDataUrl : null;
  try {
    savePreset(name, settings, withImage);
  } catch {
    // Usually the signature image doesn't fit in browser storage.
    try {
      savePreset(name, settings, null);
      alert('서명 이미지가 커서 프리셋에 함께 넣지 못했습니다. 나머지 설정만 저장했어요.');
    } catch {
      alert('브라우저 저장 공간이 부족해 프리셋을 저장하지 못했습니다.');
      return;
    }
  }
  currentPreset = name;
  fillPresetSelect();
  presetHint(`"${name}" 프리셋으로 저장했습니다.`);
});

$('preset-delete').addEventListener('click', () => {
  const name = $('preset-select').value;
  if (!name || !confirm(`"${name}" 프리셋을 지울까요?`)) return;
  deletePreset(name);
  if (currentPreset === name) currentPreset = '';
  fillPresetSelect();
  presetHint(`"${name}" 프리셋을 지웠습니다.`);
});

$('preset-reset').addEventListener('click', async () => {
  if (!confirm('모든 설정을 처음 기본값으로 되돌릴까요? 저장된 프리셋은 그대로 남습니다.')) return;
  currentPreset = '';
  fillPresetSelect();
  await applySettings(cloneDefaults(), null);
  presetHint('기본 설정으로 되돌렸습니다.');
});

$('preset-export').addEventListener('click', () => {
  const url = URL.createObjectURL(exportPresetsBlob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'photoworks-presets.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

$('preset-import').addEventListener('click', () => $('preset-file').click());
$('preset-file').addEventListener('change', async (e) => {
  e.stopPropagation();
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const n = await importPresetsFile(f);
    fillPresetSelect();
    presetHint(`프리셋 ${n}개를 가져왔습니다.`);
  } catch (err) {
    alert(`가져오지 못했습니다: ${err?.message || err}`);
  }
});

// ---------- init ----------

buildPositionGrids();
buildChips();
installedFonts = detectInstalledFonts();
fillFontSelects();
fillForm();
localFontsGranted().then(ok => { if (ok) loadLocalFonts(); });
restoreSignatureImage();
fillPresetSelect();
document.querySelector('.settings-pane').addEventListener('input', onSettingsChange);
document.querySelector('.settings-pane').addEventListener('change', onSettingsChange);
refreshFormState();
updateCount();

// Exposed for automated tests and later steps.
window.photoworks = { settings, items, addFiles, get pool() { return pool; } };

createPool().then(p => {
  pool = p;
  if (p) {
    if (signatureDataUrl) dataUrlToBlob(signatureDataUrl).then(b => p.setSignature(b));
    $('engine-hint').textContent = `사진 ${p.size}장을 동시에 백그라운드에서 처리합니다.`;
    pumpThumbs();
  } else {
    $('engine-hint').textContent = '이 브라우저는 백그라운드 처리를 지원하지 않아 화면에서 2장씩 처리합니다.';
  }
});
