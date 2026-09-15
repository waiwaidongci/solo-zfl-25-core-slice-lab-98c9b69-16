// 极简 PNG 编解码：仅依赖 node:zlib。
// 解码支持：非隔行扫描，颜色类型 0(灰度)/2(RGB)/3(调色板)/4(灰度+透明)/6(RGBA)，
// 位深 8/16（16 位取高字节），灰度与调色板额外支持 1/2/4 位，五种扫描线过滤器。
// 编码输出：8 位 RGBA、逐行 filter 0，供测试与示例图像使用。
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function readBits(buf, bitPos, numBits) {
  let v = 0;
  for (let k = 0; k < numBits; k++) {
    const p = bitPos + k;
    v = (v << 1) | ((buf[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

function unfilter(raw, width, height, stride, bpp) {
  if (raw.length < (stride + 1) * height) throw new Error("truncated_image_data");
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowIn + x];
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y > 0 ? out[prevOut + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevOut + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("unknown_filter_" + filter);
      }
      out[rowOut + x] = val & 0xff;
    }
  }
  return out;
}

function toRgba(pixels, width, height, bitDepth, colorType, palette, trns) {
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  const put = (i, r, g, b, a) => {
    const o = i * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  };
  if (colorType === 0) {
    if (bitDepth === 8) {
      for (let i = 0; i < n; i++) put(i, pixels[i], pixels[i], pixels[i], 255);
    } else if (bitDepth === 16) {
      for (let i = 0; i < n; i++) { const g = pixels[i * 2]; put(i, g, g, g, 255); }
    } else {
      const max = (1 << bitDepth) - 1;
      for (let i = 0; i < n; i++) {
        const g = Math.round((readBits(pixels, i * bitDepth, bitDepth) * 255) / max);
        put(i, g, g, g, 255);
      }
    }
  } else if (colorType === 2) {
    if (bitDepth === 8) {
      for (let i = 0; i < n; i++) put(i, pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2], 255);
    } else {
      for (let i = 0; i < n; i++) put(i, pixels[i * 6], pixels[i * 6 + 2], pixels[i * 6 + 4], 255);
    }
  } else if (colorType === 3) {
    if (!palette) throw new Error("missing_palette");
    for (let i = 0; i < n; i++) {
      const idx = bitDepth === 8 ? pixels[i] : readBits(pixels, i * bitDepth, bitDepth);
      const a = trns && idx < trns.length ? trns[idx] : 255;
      put(i, palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2], a);
    }
  } else if (colorType === 4) {
    if (bitDepth === 8) {
      for (let i = 0; i < n; i++) { const g = pixels[i * 2]; put(i, g, g, g, pixels[i * 2 + 1]); }
    } else {
      for (let i = 0; i < n; i++) { const g = pixels[i * 4]; put(i, g, g, g, pixels[i * 4 + 2]); }
    }
  } else if (colorType === 6) {
    if (bitDepth === 8) {
      pixels.copy(out, 0, 0, n * 4);
    } else {
      for (let i = 0; i < n; i++) put(i, pixels[i * 8], pixels[i * 8 + 2], pixels[i * 8 + 4], pixels[i * 8 + 6]);
    }
  } else {
    throw new Error("unsupported_color_type_" + colorType);
  }
  return out;
}

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("not_a_png");
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  let sawIHDR = false;
  let sawIEND = false;
  let idatEnded = false;
  let chunkIndex = 0;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const typeBytes = buf.subarray(pos + 4, pos + 8);
    const type = typeBytes.toString("ascii");
    // 分块类型须为 4 个英文字母，且第三字母（保留位）大写
    let typeValid = true;
    for (let i = 0; i < 4; i++) {
      const c = typeBytes[i];
      const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (!isLetter || (i === 2 && (c < 65 || c > 90))) {
        typeValid = false;
        break;
      }
    }
    if (!typeValid) throw new Error("invalid_chunk_type");
    if (pos + 12 + len > buf.length) throw new Error("truncated_chunk");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const expectedCrc = buf.readUInt32BE(pos + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== expectedCrc) {
      throw new Error("chunk_crc_mismatch");
    }
    pos += 12 + len;
    chunkIndex++;
    if (type === "IHDR") {
      if (chunkIndex !== 1 || sawIHDR) throw new Error("duplicate_ihdr");
      sawIHDR = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new Error("unsupported_compression_or_filter");
      interlace = data[12];
      continue;
    }
    if (!sawIHDR) throw new Error("ihdr_not_first");
    if (type === "IDAT") {
      if (idatEnded) throw new Error("idat_not_consecutive");
      idat.push(data);
      continue;
    }
    if (type === "IEND") {
      if (len !== 0) throw new Error("iend_not_empty");
      sawIEND = true;
      break;
    }
    if (idat.length) idatEnded = true;
    if (type === "PLTE") {
      if (palette) throw new Error("duplicate_plte");
      if (idat.length) throw new Error("plte_after_idat");
      // 长度为 3 的倍数、1–256 条目；调色板图像不得超过位深允许上限
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error("invalid_plte_length");
      if (colorType === 3 && len / 3 > (1 << bitDepth)) throw new Error("invalid_plte_length");
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      if (trns) throw new Error("duplicate_trns");
      if (idat.length) throw new Error("trns_after_idat");
      // 含 alpha 通道的颜色类型禁止 tRNS；其余类型长度须匹配
      if (colorType === 4 || colorType === 6) throw new Error("trns_not_allowed");
      if (colorType === 0 && len !== 2) throw new Error("invalid_trns_length");
      if (colorType === 2 && len !== 6) throw new Error("invalid_trns_length");
      if (colorType === 3 && (len === 0 || len > 256 || (palette && len > palette.length / 3))) {
        throw new Error("invalid_trns_length");
      }
      trns = Buffer.from(data);
    } else {
      // 关键分块（类型首字母大写）必须可识别，未知即拒绝；辅助分块（小写）忽略
      const first = type.charCodeAt(0);
      if (first >= 65 && first <= 90) throw new Error("unknown_critical_chunk_" + type);
    }
  }
  if (!sawIHDR) throw new Error("bad_header");
  if (!sawIEND) throw new Error("missing_iend");
  if (pos !== buf.length) throw new Error("data_after_iend");
  if (!width || !height) throw new Error("bad_header");
  if (interlace !== 0) throw new Error("interlaced_png_not_supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels == null) throw new Error("unsupported_color_type_" + colorType);
  const allowedDepths = colorType === 3 ? [1, 2, 4, 8] : colorType === 0 ? [1, 2, 4, 8, 16] : [8, 16];
  if (!allowedDepths.includes(bitDepth)) throw new Error("unsupported_bit_depth_" + bitDepth);
  if (!idat.length) throw new Error("missing_image_data");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const pixels = unfilter(raw, width, height, stride, bpp);
  const data = toRgba(pixels, width, height, bitDepth, colorType, palette, trns);
  return { width, height, data };
}

export function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("rgba_size_mismatch");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
