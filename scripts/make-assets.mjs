/**
 * 生成插件图标与预览图，零依赖（手写 PNG 编码）。
 * 用法: node scripts/make-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

function blendPixel(buffer, width, x, y, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0) return;
  const index = (py * width + px) * 4;
  if (index < 0 || index + 3 >= buffer.length) return;
  const srcA = Math.min(1, alpha);
  const dstA = buffer[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buffer[index] = clamp((r * srcA + buffer[index] * dstA * (1 - srcA)) / outA);
  buffer[index + 1] = clamp((g * srcA + buffer[index + 1] * dstA * (1 - srcA)) / outA);
  buffer[index + 2] = clamp((b * srcA + buffer[index + 2] * dstA * (1 - srcA)) / outA);
  buffer[index + 3] = clamp(outA * 255);
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function roundedRectAlpha(x, y, width, height, radius) {
  const rx = Math.min(Math.max(x, radius), width - radius);
  const ry = Math.min(Math.max(y, radius), height - radius);
  const dist = Math.hypot(x - rx, y - ry);
  return Math.max(0, Math.min(1, radius - dist + 0.5));
}

/** 画一个 π：数学符号里辨识度最高、几何也最简单的字形 */
function drawPi(buffer, width, height, opts) {
  const { cx, cy, sizeW, sizeH, thickness, color } = opts;
  const left = cx - sizeW / 2;
  const right = cx + sizeW / 2;
  const top = cy - sizeH / 2;
  const bottom = cy + sizeH / 2;
  const barY = top + thickness / 2;

  const strokes = [
    // 顶横
    [left, barY, right, barY],
    // 左腿，略微外撇
    [left + sizeW * 0.2, top + thickness, left + sizeW * 0.12, bottom],
    // 右腿
    [right - sizeW * 0.2, top + thickness, right - sizeW * 0.12, bottom],
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let alpha = 0;
      for (const [x1, y1, x2, y2] of strokes) {
        const distance = distanceToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2);
        alpha = Math.max(alpha, Math.max(0, Math.min(1, thickness / 2 - distance + 0.5)));
      }
      if (alpha > 0) {
        blendPixel(buffer, width, x, y, color, alpha);
      }
    }
  }
}

function drawIcon(size) {
  const buffer = Buffer.alloc(size * size * 4, 0);
  const radius = size * 0.22;

  // 背景：靛蓝 → 紫 对角渐变
  const from = [79, 70, 229];
  const to = [124, 58, 237];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size) * 0.45 + (y / size) * 0.55;
      const color = [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ];
      const alpha = roundedRectAlpha(x + 0.5, y + 0.5, size, size, radius);
      if (alpha > 0) {
        blendPixel(buffer, size, x, y, color, alpha);
      }
    }
  }

  // 柔光
  const glow = { x: size * 0.78, y: size * 0.22, r: size * 0.5 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - glow.x, y - glow.y) / glow.r;
      const alpha = Math.max(0, 1 - d) ** 2 * 0.28;
      if (alpha > 0) {
        blendPixel(buffer, size, x, y, [196, 181, 253], alpha * (buffer[(y * size + x) * 4 + 3] / 255));
      }
    }
  }

  drawPi(buffer, size, size, {
    cx: size / 2,
    cy: size / 2,
    sizeW: size * 0.48,
    sizeH: size * 0.5,
    thickness: Math.max(3, size * 0.085),
    color: [255, 255, 255],
  });

  return encodePng(size, size, buffer);
}

function drawPreview(width, height) {
  const buffer = Buffer.alloc(width * height * 4, 0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y / height;
      const color = [15 + 20 * t, 23 + 20 * t, 60 + 60 * t];
      blendPixel(buffer, width, x, y, color, 1);
    }
  }

  // 左侧暗块 + 卡片
  const card = { x: width * 0.18, y: height * 0.24, w: width * 0.64, h: height * 0.52, r: 28 };
  for (let y = card.y; y < card.y + card.h; y++) {
    for (let x = card.x; x < card.x + card.w; x++) {
      const lx = x - card.x;
      const ly = y - card.y;
      const alpha =
        roundedRectAlpha(lx + 0.5, ly + 0.5, card.w, card.h, card.r) *
        Math.max(
          0,
          Math.min(1, roundedRectAlpha(lx + 0.5, ly + 0.5, card.w, card.h, card.r) * 1.0),
        );
      blendPixel(buffer, width, x, y, [248, 250, 252], alpha * 0.96);
    }
  }

  // 卡片里的占位文本行
  const lines = [
    { x: 0.24, y: 0.34, w: 0.3 },
    { x: 0.24, y: 0.42, w: 0.22 },
    { x: 0.24, y: 0.56, w: 0.3 },
    { x: 0.24, y: 0.64, w: 0.24 },
  ];
  for (const line of lines) {
    const x0 = Math.round(width * line.x);
    const y0 = Math.round(height * line.y);
    const x1 = Math.round(width * (line.x + line.w));
    for (let y = y0; y < y0 + 10; y++) {
      for (let x = x0; x < x1; x++) {
        blendPixel(buffer, width, x, y, [71, 85, 105], 0.28);
      }
    }
  }

  // 右侧公式块
  const mathBox = { x: width * 0.62, y: height * 0.44, w: width * 0.18, h: height * 0.17, r: 12 };
  for (let y = mathBox.y; y < mathBox.y + mathBox.h; y++) {
    for (let x = mathBox.x; x < mathBox.x + mathBox.w; x++) {
      const alpha = roundedRectAlpha(
        x - mathBox.x + 0.5,
        y - mathBox.y + 0.5,
        mathBox.w,
        mathBox.h,
        mathBox.r,
      );
      blendPixel(buffer, width, x, y, [99, 102, 241], alpha * 0.9);
    }
  }

  drawPi(buffer, width, height, {
    cx: width * 0.71,
    cy: height * 0.525,
    sizeW: height * 0.062,
    sizeH: height * 0.072,
    thickness: 7,
    color: [255, 255, 255],
  });

  return encodePng(width, height, buffer);
}

fs.writeFileSync(path.join(root, "icon.png"), drawIcon(160));
fs.writeFileSync(path.join(root, "preview.png"), drawPreview(1024, 768));
console.log("icon.png / preview.png generated");
