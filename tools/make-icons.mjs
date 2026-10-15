/**
 * Extension icon generator — pure Node.js, no npm packages.
 *
 *   node tools/make-icons.mjs                 draw the built-in default icon
 *   node tools/make-icons.mjs --from <png>    downscale your own source image
 *
 * Writes icons/icon16.png, icon32.png, icon48.png, icon128.png.
 *
 * The default mark is a WhatsApp-inspired speech bubble drawn with signed
 * distance fields and supersampled, so every edge is anti-aliased and the
 * mark stays legible all the way down to 16 px.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 1024; // internal supersampling canvas

/* ============================ PNG plumbing ============================ */

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(img) {
  const colorType = img.channels === 4 ? 6 : 2;
  const stride = img.width * img.channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
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

function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG file');
  let off = 8, ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported PNG encoding');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('unsupported colour type ' + ihdr.colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr, bpp = channels, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++], rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[p + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[rowStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[rowStart - stride + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      out[rowStart + x] = v & 0xff;
    }
    p += stride;
  }
  return { width, height, channels, data: out };
}

/** Box-filter downscale (correct for large reductions). */
function resize(src, target) {
  const sx = src.width / target, sy = src.height / target;
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
      dst[o] = Math.round(r / n); dst[o + 1] = Math.round(g / n); dst[o + 2] = Math.round(b / n);
      if (src.channels === 4) dst[o + 3] = Math.round(a / n);
    }
  }
  return { width: target, height: target, channels: src.channels, data: dst };
}

/* ============================ Default mark ============================ */

/** Distance to a rounded rectangle centred on (cx, cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a convex triangle: negative inside. */
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]];
  const field = (x, y) => {
    let d = -Infinity;
    for (const [x0, y0, x1, y1] of edges) {
      const ex = x1 - x0, ey = y1 - y0;
      const len = Math.hypot(ex, ey) || 1;
      d = Math.max(d, ((x - x0) * -ey + (y - y0) * ex) / len);
    }
    return d;
  };
  // The half-plane field above is only a signed distance when the winding
  // puts the interior on the negative side. Anchor the sign on the centroid
  // so the triangle is "inside" regardless of vertex order.
  const insideIsNegative = field((ax + bx + cx) / 3, (ay + by + cy) / 3) < 0;
  const d = field(px, py);
  return insideIsNegative ? d : -d;
}

/**
 * Draw the default icon at SS x SS into an RGBA buffer.
 *
 * A WhatsApp-green rounded square with a white speech-bubble outline:
 * one bold shape, so it survives down to 16 px.
 */
function drawDefaultIcon() {
  const data = Buffer.alloc(SS * SS * 4);

  // Background: diagonal green gradient + a soft top-left highlight.
  const cA = [0.22, 0.89, 0.44]; // #38E370 bright
  const cB = [0.03, 0.54, 0.41]; // #078968 deep
  const hx = 0.30, hy = 0.20, hr = 0.78;

  const BUBBLE = { cx: 0.5, cy: 0.445, hw: 0.295, hh: 0.225, r: 0.10 };
  const INNER = { cx: 0.5, cy: 0.445, hw: 0.295 - 0.062, hh: 0.225 - 0.062, r: 0.10 - 0.045 };
  const TAIL = [0.325, 0.575, 0.185, 0.815, 0.475, 0.625];

  const CORNER = 0.225;
  const HW = 0.5 - 0.035; // slight inset so the rounded square is not edge-to-edge

  for (let y = 0; y < SS; y++) {
    const ny = (y + 0.5) / SS;
    for (let x = 0; x < SS; x++) {
      const nx = (x + 0.5) / SS;

      const dBg = sdRoundRect(nx, ny, 0.5, 0.5, HW, HW, CORNER);
      if (dBg > 0) continue; // transparent outside the rounded square

      const t = Math.min(1, Math.max(0, (nx + ny) / 2));
      let r = cA[0] + (cB[0] - cA[0]) * t;
      let g = cA[1] + (cB[1] - cA[1]) * t;
      let b = cA[2] + (cB[2] - cA[2]) * t;

      // radial highlight
      const hd = Math.hypot(nx - hx, ny - hy) / hr;
      const hi = Math.max(0, 1 - hd) ** 2 * 0.22;
      r += (1 - r) * hi; g += (1 - g) * hi; b += (1 - b) * hi;

      // Bubble outline: (body ∪ tail) minus inner shape.
      const outer = Math.min(
        sdRoundRect(nx, ny, BUBBLE.cx, BUBBLE.cy, BUBBLE.hw, BUBBLE.hh, BUBBLE.r),
        sdTriangle(nx, ny, ...TAIL)
      );
      const inner = sdRoundRect(nx, ny, INNER.cx, INNER.cy, INNER.hw, INNER.hh, INNER.r);
      if (outer < 0 && inner > 0) {
        r = 1; g = 1; b = 1;
      }

      const o = (y * SS + x) * 4;
      data[o] = Math.round(r * 255);
      data[o + 1] = Math.round(g * 255);
      data[o + 2] = Math.round(b * 255);
      data[o + 3] = 255;
    }
  }
  return { width: SS, height: SS, channels: 4, data };
}

/* ================================ Main ================================ */

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf('--from');
let source = null;

if (fromIdx !== -1) {
  source = resolve(argv[fromIdx + 1] || '');
  if (!existsSync(source)) {
    console.error('source not found: ' + source);
    process.exit(1);
  }
}

let img;
if (source) {
  img = decodePng(readFileSync(source));
  console.log(`source image : ${source}`);
  console.log(`              ${img.width}x${img.height}, ${img.channels} channel(s)`);
} else {
  img = drawDefaultIcon();
  console.log('default mark : speech bubble, drawn with SDFs at ' + SS + 'x' + SS);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const out = encodePng(resize(img, size));
  writeFileSync(join(OUT_DIR, `icon${size}.png`), out);
  console.log(`  wrote icons/icon${size}.png  (${out.length} bytes)`);
}
console.log('done.');