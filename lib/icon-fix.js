import zlib from 'node:zlib';

// 有的官方图标（比如 grok.com 的）自带 iOS 那种大圆角，四个角是白底。界面上的头像圆角小，白角就露出来了。
// 这里把四个角上和外边连着的浅色底（包括圆角边上的过渡色）填成图标自己的底色，变成一整块方图，圆角交给界面统一切。
// 只认 8 位、不隔行的 PNG（调色板、RGB、RGBA）；认不出来、或者四个角本来就不是浅色的，原样返回

function readPng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let pos = 8;
  let ihdr;
  let palette;
  let trns;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace) return null;
  const channels = { 2: 3, 3: 1, 6: 4 }[ihdr.color];
  if (!channels || (ihdr.color === 3 && !palette)) return null;
  const { w, h } = ihdr;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < h * (stride + 1)) return null;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  // 统一转成 RGBA
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ihdr.color === 3) {
      const k = px[i];
      out[i * 4] = palette[k * 3];
      out[i * 4 + 1] = palette[k * 3 + 1];
      out[i * 4 + 2] = palette[k * 3 + 2];
      out[i * 4 + 3] = trns && k < trns.length ? trns[k] : 255;
    } else {
      out[i * 4] = px[i * channels];
      out[i * 4 + 1] = px[i * channels + 1];
      out[i * 4 + 2] = px[i * channels + 2];
      out[i * 4 + 3] = channels === 4 ? px[i * 4 + 3] : 255;
    }
  }
  return { w, h, rgba: out };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng({ w, h, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB，不带透明
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = rgba[i];
      raw[o + 1] = rgba[i + 1];
      raw[o + 2] = rgba[i + 2];
    }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 亮度（透明的按白底算）
const lum = (p, i) => {
  const a = p[i + 3] / 255;
  return (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) * a + 255 * (1 - a);
};

export function squareIcon(buf) {
  let img;
  try {
    img = readPng(buf);
  } catch {
    return buf;
  }
  if (!img) return buf;
  const { w, h, rgba } = img;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1];
  if (!corners.every((i) => lum(rgba, i * 4) > 200)) return buf; // 角上不是浅色底：本来就是方图
  // 底色取正中间那一行最左边往里一点（图标主体的颜色）
  const mid = (Math.floor(h / 2) * w + Math.floor(w / 8)) * 4;
  const base = [rgba[mid], rgba[mid + 1], rgba[mid + 2]];
  const baseLum = lum(rgba, mid);
  if (baseLum > 120) return buf; // 主体是浅色的图标，填了反而难看，不动
  // 从四个角往里填：和底色不一样的（白底、圆角边上的灰色过渡、描边那一圈更黑的线）都换成底色，碰到底色就停
  const seen = new Uint8Array(w * h);
  const stack = [...corners];
  let filled = 0;
  while (stack.length) {
    const i = stack.pop();
    if (seen[i]) continue;
    seen[i] = 1;
    if (Math.abs(lum(rgba, i * 4) - baseLum) <= 2) continue;
    rgba[i * 4] = base[0];
    rgba[i * 4 + 1] = base[1];
    rgba[i * 4 + 2] = base[2];
    rgba[i * 4 + 3] = 255;
    filled++;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  if (filled > w * h * 0.4) return buf; // 填掉了一大半：图不是想的那样（比如浅色图标），不动
  return writePng(img);
}
