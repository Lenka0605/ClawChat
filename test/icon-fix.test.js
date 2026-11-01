import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { squareIcon } from '../lib/icon-fix.js';

// 造一张 PNG：w×h，按 (x, y) 给颜色（RGB）
function png(w, h, color) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(color(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // 测试里不校验 CRC
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pixel(buf, x, y) {
  // squareIcon 输出的是 RGB、过滤方式 0 的 PNG
  const w = buf.readUInt32BE(16);
  let pos = 8;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const o = y * (w * 3 + 1) + 1 + x * 3;
  return [...raw.subarray(o, o + 3)];
}

// 白底上一个黑色圆角方块，中间一道白色的标
const rounded = (x, y) => {
  const r = 12;
  const cx = Math.min(Math.max(x, r), 47 - r);
  const cy = Math.min(Math.max(y, r), 47 - r);
  const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  if (!inside) return [255, 255, 255];
  if (x >= 20 && x <= 27 && y >= 10 && y <= 37) return [255, 255, 255];
  return [5, 5, 5];
};

test('自带大圆角、四个角是白底的深色图标：白角填成底色，中间的标不动', () => {
  const out = squareIcon(png(48, 48, rounded));
  assert.deepEqual(pixel(out, 0, 0), [5, 5, 5]);
  assert.deepEqual(pixel(out, 47, 47), [5, 5, 5]);
  assert.deepEqual(pixel(out, 2, 2), [5, 5, 5]);
  assert.deepEqual(pixel(out, 24, 24), [255, 255, 255], '白色的标还在');
});

test('本来就是方图、浅色图标、认不出来的：原样返回', () => {
  const square = png(32, 32, () => [5, 5, 5]);
  assert.equal(squareIcon(square), square);
  const light = png(32, 32, (x, y) => (x < 4 || y < 4 ? [255, 255, 255] : [240, 200, 160]));
  assert.equal(squareIcon(light), light);
  const junk = Buffer.from('not a png');
  assert.equal(squareIcon(junk), junk);
});
