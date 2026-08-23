// Generates icons-src/appicon.png deterministically with no image dependencies: the same
// blurple rounded square + white audio waveform as the bridge's own packaging/icon-256.png,
// drawn at 1024x1024 because 'tauri icon' wants a large square source. Adapted from the main
// repository's scripts/gen-icon.mjs so both projects ship one visual identity.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const RADIUS = 192;
const BARS = [0.28, 0.55, 0.95, 0.65, 1.0, 0.45, 0.75, 0.3];
const BAR_WIDTH = 56;
const GAP = 40;
const TOTAL = BARS.length * BAR_WIDTH + (BARS.length - 1) * GAP;
const X0 = (SIZE - TOTAL) / 2;
const MAX_HEIGHT = 528;
const Y_MID = SIZE / 2 + 24;

const table = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Rounded-rectangle coverage via distance to each corner radius.
    const dx = Math.max(RADIUS - x, x - (SIZE - 1 - RADIUS), 0);
    const dy = Math.max(RADIUS - y, y - (SIZE - 1 - RADIUS), 0);
    const outside = Math.hypot(dx, dy) > RADIUS;
    let r = 88, g = 101, b = 242, a = outside ? 0 : 255; // Discord blurple #5865F2

    for (let bar = 0; bar < BARS.length; bar++) {
      const bx = X0 + bar * (BAR_WIDTH + GAP);
      if (x < bx || x >= bx + BAR_WIDTH) continue;
      const height = Math.round(BARS[bar] * MAX_HEIGHT);
      if (Math.abs(y - Y_MID) <= height / 2) {
        r = g = b = 255;
        break;
      }
    }

    const i = (y * SIZE + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }
}

// PNG: filter byte 0 per scanline, then zlib.
const scanlines = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '..', 'icons-src'), { recursive: true });
const out = join(here, '..', 'icons-src', 'appicon.png');
writeFileSync(out, png);
console.log('wrote ' + out + ' (' + SIZE + 'x' + SIZE + ', ' + png.length + ' bytes)');
