import { loadSettings, saveSettings } from './settings.js';
import { computeTargetSize } from './resize.js';
import { buildFileName } from './filename.js';
import { processFile, outputMime, registerOverlay, loadPreviewBase, renderPreview } from './pipeline.js';
import { canPickFolder, createSaver } from './exporter.js';
import { readExif, exifTokens, photoDate, TOKEN_NAMES } from './exif.js';
import { drawOverlays, setSignatureImage, getSignatureImage } from './overlay.js';

registerOverlay(drawOverlays);

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
if (!canPickFolder && settings.output.saveTarget === 'folder') settings.output.saveTarget = 'download';

/** @type {{id:number, file:File, el:HTMLElement, width?:number, height?:number}[]} */
const items = [];
let nextId = 1;
let running = false;
let cancelRequested = false;

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
      if (Number.isFinite(v) && (el.min === '0' ? v >= 0 : v > 0)) settings[group][key] = v;
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
  $('quality-row').hidden = fmt === 'image/png';
  $('quality-out').textContent = settings.output.quality;
  $('strip-gps').disabled = !settings.output.keepExif;

  const sample = items[0];
  const mime = sample ? outputMime(sample.file, fmt) : (fmt === 'same' ? 'image/jpeg' : fmt);
  $('exif-keep-hint').hidden = !settings.output.keepExif || mime === 'image/jpeg';
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
  $('clear-all').disabled = running || items.length === 0;
  $('run').disabled = running || items.length === 0;
}

function updateDims(it) {
  const el = it.el.querySelector('.dims');
  if (!it.width) { el.textContent = '크기 읽는 중…'; return; }
  const t = computeTargetSize(it.width, it.height, settings.resize);
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
  if (previewItem === it) selectPreview(items[0] || null);
  updateCount();
  refreshFormState();
}

// Thumbnails: decode in the background (2 at a time) to get real
// orientation-corrected dimensions and a small preview image.
const thumbQueue = [];
let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 2 && thumbQueue.length) {
    const it = thumbQueue.shift();
    if (it.removed) continue;
    thumbActive++;
    makeThumb(it).finally(() => { thumbActive--; pumpThumbs(); });
  }
}
async function makeThumb(it) {
  const img = it.el.querySelector('img');
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

async function selectPreview(it) {
  previewItem = it;
  previewBase = null;
  items.forEach(x => x.el.classList.toggle('selected', x === it));
  $('preview').hidden = !it;
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
    const { width, height } = await renderPreview($('preview-canvas'), pb, index, settings);
    const t = exifTokens(pb.exif?.tags, pb.file);
    const bits = [`저장 크기 ${width}×${height}`, t['카메라'], t['촬영일시']].filter(Boolean);
    if (!pb.exif) bits.push('EXIF 없음');
    $('preview-info').textContent = bits.join(' · ');
  });
}

// ---------- signature image ----------

const SIG_IMAGE_KEY = 'photoworks-web:signature-image:v1';

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
  try { localStorage.removeItem(SIG_IMAGE_KEY); } catch { /* ignore */ }
  $('sig-image-thumb').removeAttribute('src');
  $('sig-image-hint').textContent = '배경이 투명한 PNG가 가장 잘 어울립니다.';
  refreshFormState();
});

async function restoreSignatureImage() {
  let dataUrl = null;
  try { dataUrl = localStorage.getItem(SIG_IMAGE_KEY); } catch { /* ignore */ }
  if (!dataUrl) return;
  try { await useSignatureImage(await (await fetch(dataUrl)).blob(), false); } catch { /* ignore */ }
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

function setProgress(done, total, failed) {
  $('progress').hidden = false;
  $('progress-bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progress-text').textContent = `${done} / ${total}장 처리${failed ? ` · 실패 ${failed}장` : ''}`;
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
  $('cancel').hidden = false;
  updateCount();
  const queue = [...items];
  const total = queue.length;
  let done = 0, failed = 0, next = 0;
  queue.forEach(it => setStatus(it, '대기'));
  setProgress(0, total, 0);

  // Encode up to 2 photos at once, but write them strictly in list order so
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
        const out = await processFile(it.file, index, settings);
        await turn(index);
        const finalName = await saver.save(out.name, out.blob);
        setStatus(it, `저장됨: ${finalName}`, 'done');
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
  await Promise.all([worker(), worker()]);

  if (cancelRequested) {
    queue.slice(next).forEach(it => setStatus(it, '중지됨'));
    $('progress-text').textContent += ' · 중지됨';
  } else {
    $('progress-text').textContent = `완료: ${total - failed}장 저장${failed ? `, ${failed}장 실패` : ''}`;
  }
  running = false;
  $('cancel').hidden = true;
  updateCount();
}

$('run').addEventListener('click', run);
$('cancel').addEventListener('click', () => { cancelRequested = true; });

// ---------- init ----------

buildPositionGrids();
buildChips();
fillForm();
restoreSignatureImage();
document.querySelector('.settings-pane').addEventListener('input', onSettingsChange);
document.querySelector('.settings-pane').addEventListener('change', onSettingsChange);
refreshFormState();
updateCount();

// Exposed for automated tests and later steps.
window.photoworks = { settings, items, addFiles };
