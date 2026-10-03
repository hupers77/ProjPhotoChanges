// Writes the print resolution (DPI) into encoded JPEG (JFIF header) and PNG
// (pHYs chunk) files. WebP has no standard place for it.

function setJpegDpi(buf, dpi) {
  const hasJfif = buf[2] === 0xFF && buf[3] === 0xE0 && buf[6] === 0x4A && buf[7] === 0x46 && buf[8] === 0x49 && buf[9] === 0x46;
  if (hasJfif) {
    const out = buf.slice();
    out[13] = 1; // dots per inch
    out[14] = dpi >> 8; out[15] = dpi & 255;
    out[16] = dpi >> 8; out[17] = dpi & 255;
    return out;
  }
  const app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
  const out = new Uint8Array(buf.length + app0.length);
  out.set(buf.subarray(0, 2)); out.set(app0, 2); out.set(buf.subarray(2), 2 + app0.length);
  return out;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function setPngDpi(buf, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1; // per metre
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Drop an existing pHYs, then insert ours right after IHDR (8 sig + 25 IHDR).
  const parts = [buf.subarray(0, 33), chunk];
  let p = 33;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 8 <= buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    if (type !== 'pHYs') parts.push(buf.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  return new Blob(parts, { type: 'image/png' });
}

export async function applyDpi(blob, mime, dpi) {
  dpi = Math.round(Number(dpi));
  if (!dpi || dpi < 1 || dpi > 65535) return blob;
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (mime === 'image/jpeg' && buf[0] === 0xFF && buf[1] === 0xD8) return new Blob([setJpegDpi(buf, dpi)], { type: mime });
  if (mime === 'image/png' && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return setPngDpi(buf, dpi);
  return blob;
}
