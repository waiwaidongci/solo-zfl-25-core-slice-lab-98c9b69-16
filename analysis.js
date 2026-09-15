// 薄片显微图像粒度与矿物统计：
// 灰度化（透明像素按白底合成）→ 颜色阈值二值化 → 8 连通颗粒提取 →
// 等效圆粒径（按标尺换算 µm）→ 粒径分布分档与矿物面积占比。
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

export function analyzeGrains(image, options) {
  const { width, height, data } = image;
  const { threshold, polarity = "dark", umPerPx, minAreaPx = 1, binCount = 8 } = options;
  const total = width * height;

  const mask = new Uint8Array(total);
  let mineralAreaPx = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    const r = data[o] * a + 255 * (1 - a);
    const g = data[o + 1] * a + 255 * (1 - a);
    const b = data[o + 2] * a + 255 * (1 - a);
    const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const hit = polarity === "light" ? gray >= threshold : gray < threshold;
    if (hit) {
      mask[i] = 1;
      mineralAreaPx++;
    }
  }

  // 8 连通域标记（迭代式 flood fill，避免递归爆栈）
  const labels = new Int32Array(total);
  const stack = new Int32Array(total);
  const areas = [];
  for (let s = 0; s < total; s++) {
    if (!mask[s] || labels[s]) continue;
    const label = areas.length + 1;
    let sp = 0;
    let area = 0;
    stack[sp++] = s;
    labels[s] = label;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % width;
      const y = (p / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
    areas.push(area);
  }

  const um2PerPx = umPerPx * umPerPx;
  const grains = areas
    .filter((a) => a >= minAreaPx)
    .map((areaPx) => ({
      areaUm2: areaPx * um2PerPx,
      diameterUm: 2 * Math.sqrt(areaPx / Math.PI) * umPerPx
    }))
    .sort((a, b) => a.diameterUm - b.diameterUm);

  const count = grains.length;
  const diameters = grains.map((g) => g.diameterUm);
  const sum = diameters.reduce((acc, d) => acc + d, 0);
  const mean = count ? sum / count : 0;
  const median = count
    ? count % 2
      ? diameters[(count - 1) / 2]
      : (diameters[count / 2 - 1] + diameters[count / 2]) / 2
    : 0;
  const max = count ? diameters[count - 1] : 0;
  const min = count ? diameters[0] : 0;

  const distribution = [];
  if (count && max > 0) {
    const step = max / binCount;
    for (let i = 0; i < binCount; i++) {
      distribution.push({ from: round2(i * step), to: round2((i + 1) * step), count: 0, areaUm2: 0 });
    }
    for (const grain of grains) {
      const idx = Math.min(binCount - 1, Math.floor(grain.diameterUm / step));
      distribution[idx].count++;
      distribution[idx].areaUm2 = round2(distribution[idx].areaUm2 + grain.areaUm2);
    }
  }

  return {
    grainCount: count,
    mineralAreaPx,
    totalAreaPx: total,
    areaFraction: round4(total ? mineralAreaPx / total : 0),
    mineralAreaUm2: round2(mineralAreaPx * um2PerPx),
    totalAreaUm2: round2(total * um2PerPx),
    meanDiameterUm: round2(mean),
    medianDiameterUm: round2(median),
    maxDiameterUm: round2(max),
    minDiameterUm: round2(min),
    distribution
  };
}
