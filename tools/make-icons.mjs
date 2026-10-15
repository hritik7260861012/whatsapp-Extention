/**
 * Regenerate the extension icons from a source image.
 *
 *   node tools/make-icons.mjs "<source.png>"
 *
 * Pure Node.js: no npm packages. Decodes PNG (8-bit, colour type 2/6,
 * non-interlaced), box-filters it down, and re-encodes as PNG.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');
const SIZES = [16, 32, 48, 128];

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* ---------------- Decode ---------------- */
function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG file');

  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('missing IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth} (need 8)`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[rowStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[rowStart - stride + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter type ${filter} on row ${y}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    p += stride;
  }
  return { width, height, channels, data: out };
}

/* ---------------- Resize (box / area average) ---------------- */
function resize(src, target) {
  const sx = src.width / target;
  const sy = src.height / target;
  const dst = Buffer.alloc(target * target * src.channels);
  for (let y = 0; y < target; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < target; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          const i = (yy * src.width + xx) * src.channels;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2];
          a += src.channels === 4 ? src.data[i + 3] : 255;
          n++;
        }
      }
      const o = (y * target + x) * src.channels;
      dst[o] = Math.round(r / n);
      dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n);
      if (src.channels === 4) dst[o + 3] = Math.round(a / n);
    }
  }
  return { width: target, height: target, channels: src.channels, data: dst };
}

/* ---------------- Encode ---------------- */
function encodePng(img) {
  const colorType = img.channels === 4 ? 6 : 2;
  const stride = img.width * img.channels;
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- Main ---------------- */
const source = resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(source)) {
  console.error('usage: node tools/make-icons.mjs "<source.png>"\n' +
    'source not found: ' + source);
  process.exit(1);
}

const img = decodePng(readFileSync(source));
console.log(`source : ${source}`);
console.log(`        ${img.width}x${img.height}, ${img.channels} channel(s)`);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const out = encodePng(resize(img, size));
  const dest = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(dest, out);
  console.log(`  wrote icons/icon${size}.png  (${out.length} bytes)`);
}
console.log('done.');