// Font lists for the signature / EXIF text: common macOS, Windows and Korean
// fonts that are actually installed (checked by measuring text), plus every
// font on the computer where the browser can list them (Chrome/Edge).

const CANDIDATES = [
  // Korean
  'Apple SD Gothic Neo', 'AppleGothic', 'AppleMyungjo', 'NanumGothic', 'NanumMyeongjo', 'NanumBarunGothic',
  'NanumSquare', 'Nanum Pen Script', 'Nanum Brush Script', 'NanumPen', 'NanumBrush', 'Nanum Gothic', 'Nanum Myeongjo',
  'GungSeo', 'HeadLineA', 'PCMyungjo', 'Pilgi', 'Malgun Gothic', 'Gulim', 'Dotum', 'Batang', 'Gungsuh',
  'Pretendard', 'Noto Sans KR', 'Noto Serif KR', 'Noto Sans CJK KR', 'Spoqa Han Sans Neo', 'IBM Plex Sans KR',
  'Gmarket Sans', 'BM Jua', 'BM Hanna Pro', 'BM Dohyeon', 'BM Yeonsung', 'BM Euljiro', 'Black Han Sans', 'Do Hyeon', 'Jua',
  // Latin sans
  'Helvetica Neue', 'Helvetica', 'Arial', 'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Avenir Next Condensed',
  'Futura', 'Gill Sans', 'Optima', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Lucida Grande', 'Montserrat',
  'Roboto', 'Open Sans', 'Lato', 'Inter', 'Impact', 'DIN Alternate', 'DIN Condensed', 'Skia', 'Phosphate',
  // Latin serif
  'Times New Roman', 'Times', 'Georgia', 'Palatino', 'Baskerville', 'Didot', 'Bodoni 72', 'Hoefler Text',
  'Big Caslon', 'Charter', 'Iowan Old Style', 'Garamond', 'Cochin', 'Copperplate', 'Rockwell', 'Superclarendon',
  // Script / hand
  'Snell Roundhand', 'Zapfino', 'Bradley Hand', 'Brush Script MT', 'Savoye LET', 'Apple Chancery', 'Noteworthy',
  'Marker Felt', 'Chalkboard SE', 'Chalkduster', 'Comic Sans MS', 'Segoe Script', 'Segoe Print', 'Papyrus',
  'Trattatello', 'Luminari', 'SignPainter', 'American Typewriter',
  // Mono
  'Menlo', 'Monaco', 'SF Mono', 'Courier New', 'Courier', 'Consolas', 'D2Coding', 'Andale Mono',
];

const SAMPLE = '가나다 Signature 0123 WMwm';

// A font is installed if it changes the width compared to each generic fallback.
export function detectInstalledFonts() {
  const c = document.createElement('canvas').getContext('2d');
  const width = (font) => { c.font = `40px ${font}`; return c.measureText(SAMPLE).width; };
  const bases = ['monospace', 'serif', 'sans-serif'].map(b => [b, width(b)]);
  const seen = new Set();
  const found = [];
  for (const name of CANDIDATES) {
    const key = name.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    if (bases.some(([b, w]) => width(`"${name}", ${b}`) !== w)) {
      seen.add(key);
      found.push(name);
    }
  }
  return found.sort((a, b) => a.localeCompare(b, 'ko'));
}

export const canListLocalFonts = typeof window !== 'undefined' && 'queryLocalFonts' in window;

// Asks the browser for every font family on the computer. The first call
// shows a permission prompt, so it must come from a click.
export async function listLocalFonts() {
  const fonts = await window.queryLocalFonts();
  return [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b, 'ko'));
}

// True when permission was already given (then the list loads without a click).
export async function localFontsGranted() {
  if (!canListLocalFonts || !navigator.permissions) return false;
  try { return (await navigator.permissions.query({ name: 'local-fonts' })).state === 'granted'; } catch { return false; }
}
