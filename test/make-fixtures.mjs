// 生成测试用合成薄片图像（已知颗粒数量与尺寸，便于断言）
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../png.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "fixtures");

function canvas(width, height, fill = 255) {
  const data = Buffer.alloc(width * height * 4, fill);
  return { width, height, data };
}
function dot(img, cx, cy, r, v) {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const o = (y * img.width + x) * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
      }
    }
  }
}
function rect(img, x0, y0, x1, y1, v) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
}

// grains.png：白底 5 个分离暗色圆斑（半径 6/9/13/18/25）
const g = canvas(320, 220);
dot(g, 40, 40, 6, 25);
dot(g, 110, 50, 9, 30);
dot(g, 190, 45, 13, 35);
dot(g, 60, 150, 18, 20);
dot(g, 200, 150, 25, 40);

// mixed.png：暗色圆斑 + 灰色矩形（阈值 128 时全部计入；阈值 40 时只剩深色圆）
const m = canvas(320, 220);
dot(m, 60, 60, 15, 20);
dot(m, 160, 70, 20, 25);
rect(m, 200, 130, 290, 190, 90);
dot(m, 90, 170, 12, 110);

// tiny.png：4×4，尺寸异常
const t = canvas(4, 4);

// third.png：另一组合法颗粒（保存失败测试用的新图像）
const h3 = canvas(200, 140);
dot(h3, 50, 50, 14, 30);
dot(h3, 130, 80, 20, 25);

await mkdir(outDir, { recursive: true });
const grainsBuf = encodePng(g.width, g.height, g.data);
await writeFile(join(outDir, "grains.png"), grainsBuf);
await writeFile(join(outDir, "mixed.png"), encodePng(m.width, m.height, m.data));
await writeFile(join(outDir, "tiny.png"), encodePng(t.width, t.height, t.data));
await writeFile(join(outDir, "third.png"), encodePng(h3.width, h3.height, h3.data));
await writeFile(join(outDir, "not-a-png.png"), Buffer.from("this is definitely not a png file"));
await writeFile(join(outDir, "empty.png"), Buffer.alloc(0));

// corrupt-crc.png：IDAT 数据区翻转一字节，分块 CRC 不变 → 校验和错误
const corrupt = Buffer.from(grainsBuf);
const idatPos = corrupt.indexOf(Buffer.from("IDAT"));
corrupt[idatPos + 14] ^= 0xff;
await writeFile(join(outDir, "corrupt-crc.png"), corrupt);

// truncated.png：尾部截断
await writeFile(join(outDir, "truncated.png"), grainsBuf.subarray(0, grainsBuf.length - 20));
console.log("fixtures written to", outDir);
