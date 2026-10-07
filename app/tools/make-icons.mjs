/* 生成 PWA 图标（纯 Node，无依赖）：手写 PNG 编码 + zlib。
   为什么自己画：manifest 引用的图标若不存在，iPad 添加到主屏时会拿网页截图当图标，
   糊成一团。这里画一个足够辨认的"日历"形：暖木底 + 圆角卡片 + 顶部色条 + 日期点阵。
   用法：node tools/make-icons.mjs   （改尺寸或配色后重跑即可） */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'icons');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                                        // filter: none
    for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y, size); raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                              // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#f3ece1'), CARD = hex('#fbf6ec'), BAR = hex('#a9722e'), DOT = hex('#7a6a55'), LINE = hex('#ddd0ba');

function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}
function make(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.16 : size * 0.06;      // maskable 需要更大的安全边距
  const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad, r = size * 0.1;
  const barH = (y1 - y0) * 0.22, dotR = (y1 - y0) * 0.055;
  return png(size, (x, y) => {
    if (!inRounded(x, y, x0, y0, x1, y1, r)) return [...BG, 255];
    if (y < y0 + barH) return [...BAR, 255];             // 顶部色条
    // 三列两行的日期点阵
    const gx = [0.28, 0.5, 0.72], gy = [0.52, 0.76];
    for (const fx of gx) for (const fy of gy) {
      const cx = x0 + (x1 - x0) * fx, cy = y0 + (y1 - y0) * fy;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= dotR * dotR) return [...DOT, 255];
    }
    const ly = y0 + (y1 - y0) * 0.36;                    // 色条下沿的分隔线
    if (Math.abs(y - ly) <= size * 0.006) return [...LINE, 255];
    return [...CARD, 255];
  });
}
const jobs = [['icon-192.png', 192, {}], ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}]];   // iOS 主屏图标：180×180，不透明底
for (const [name, size, opt] of jobs) {
  const buf = make(size, opt);
  writeFileSync(join(OUT, name), buf);
  console.log(`  ${name.padEnd(26)} ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log('图标已生成到 app/icons/');
