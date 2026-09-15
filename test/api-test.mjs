// API 级验证：功能、去重、重算、拒绝场景、并发、失败回滚、重启保留。
// 使用独立临时数据目录与端口，不污染正式数据。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../png.js";
import { analyzeGrains } from "../analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const PORT = 3217;
const base = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok -", name); }
  else { failed++; console.error("  FAIL -", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 400)); }
}
async function req(method, path, body) {
  const res = await fetch(base + path, body !== undefined
    ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}
const fixtures = {};
async function loadFixtures() {
  for (const name of ["grains.png", "mixed.png", "tiny.png", "not-a-png.png", "empty.png"]) {
    const buf = await readFile(join(__dirname, "fixtures", name));
    fixtures[name] = { buf, dataUrl: "data:image/png;base64," + buf.toString("base64") };
  }
}
function localExpect(name, threshold, polarity, umPerPx) {
  const img = decodePng(fixtures[name].buf);
  return analyzeGrains(img, { threshold, polarity, umPerPx });
}

let server = null;
const workDir = await mkdtemp(join(tmpdir(), "slice-api-test-"));
const dataFile = join(workDir, "data.json");
const uploadsDir = join(workDir, "uploads");
async function startServer() {
  server = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, UPLOADS_DIR: uploadsDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 10000);
    server.stdout.on("data", d => {
      if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); }
    });
  });
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  server = null;
}

try {
  await loadFixtures();
  await startServer();
  console.log("workDir:", workDir);

  // ---------- 基础建档 / 推进（旧入口） ----------
  console.log("\n[旧入口：建档与推进]");
  const create = await req("POST", "/api/samples", { project: "验证矿", borehole: "ZK-1", coreBox: "B-1", depth: "10m", owner: "测试", sliceId: "SL-T1", method: "单偏光" });
  check("创建样本 201", create.status === 201, create);
  const sid = create.data.id;
  for (const step of ["切割", "研磨", "观察"]) {
    const r = await req("POST", `/api/samples/${sid}/slices/SL-T1/logs`, { step, note: "推进" });
    check(`推进到${step} 200`, r.status === 200, r);
  }
  const notObserved = await req("POST", "/api/samples", { project: "未观察矿", borehole: "ZK-2", coreBox: "B-2", depth: "20m", owner: "测试", sliceId: "SL-T2", method: "无" });
  const sid2 = notObserved.data.id;

  // ---------- 拒绝场景 ----------
  console.log("\n[拒绝场景]");
  let r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("缺图像 → 400 image_required", r.status === 400 && r.data.error === "image_required", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: "", threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("空图像串 → 400 image_required", r.status === 400 && r.data.error === "image_required", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["empty.png"].dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("0 字节图像 → 400 image_required", r.status === 400 && r.data.error === "image_required", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["not-a-png.png"].dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("非 PNG → 400 image_decode_failed", r.status === 400 && r.data.error === "image_decode_failed", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["tiny.png"].dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("4×4 尺寸异常 → 400 image_size_abnormal", r.status === 400 && r.data.error === "image_size_abnormal", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 128 });
  check("未标尺 → 400 scale_required", r.status === 400 && r.data.error === "scale_required", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 128, scale: { pixels: 0, microns: 500 } });
  check("标尺为 0 → 400 scale_required", r.status === 400 && r.data.error === "scale_required", r.data);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 999, scale: { pixels: 100, microns: 500 } });
  check("阈值越界 → 400 threshold_invalid", r.status === 400 && r.data.error === "threshold_invalid", r.data);
  r = await req("POST", `/api/samples/${sid2}/slices/SL-T2/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("未观察切片 → 409 slice_not_observed", r.status === 409 && r.data.error === "slice_not_observed", r.data);
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  check("拒绝后无残留记录", r.status === 200 && r.data.length === 0, r.data);

  // ---------- 上传与统计正确性 ----------
  console.log("\n[上传与统计]");
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, name: "grains.png", threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("上传 grains.png → 201", r.status === 201 && r.data.deduplicated === false, r.data);
  const grainsAnalysis = r.data.analysis;
  const expect1 = localExpect("grains.png", 128, "dark", 5);
  check("颗粒数=5", grainsAnalysis.result.grainCount === 5, grainsAnalysis.result);
  check("面积占比与本地一致", grainsAnalysis.result.areaFraction === expect1.areaFraction, [grainsAnalysis.result.areaFraction, expect1.areaFraction]);
  check("粒径分布分档合计=颗粒数", grainsAnalysis.result.distribution.reduce((s, b) => s + b.count, 0) === 5);
  check("标尺换算 umPerPx=5", grainsAnalysis.scale.umPerPx === 5, grainsAnalysis.scale);
  check("平均粒径与本地一致", grainsAnalysis.result.meanDiameterUm === expect1.meanDiameterUm, [grainsAnalysis.result.meanDiameterUm, expect1.meanDiameterUm]);

  // ---------- 重复分析只保留一次 ----------
  console.log("\n[去重]");
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, name: "grains.png", threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("重复上传 → 200 deduplicated", r.status === 200 && r.data.deduplicated === true, r.data);
  check("记录 id 不变", r.data.analysis.id === grainsAnalysis.id);
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 30, scale: { pixels: 100, microns: 500 } });
  check("同图不同阈值仍去重", r.status === 200 && r.data.deduplicated === true, r.data);
  check("按新阈值重算（颗粒数 5→2）", r.data.analysis.result.grainCount === 2, r.data.analysis.result);
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  check("列表仍只有 1 条", r.data.length === 1, r.data.length);
  r = await req("PATCH", `/api/analyses/${grainsAnalysis.id}`, { threshold: 128 });
  check("阈值改回 128 → 颗粒数 5", r.status === 200 && r.data.analysis.result.grainCount === 5, r.data);

  // ---------- 第二张图 + 重算 ----------
  console.log("\n[重算]");
  r = await req("POST", `/api/samples/${sid}/slices/SL-T1/analyses`, { image: fixtures["mixed.png"].dataUrl, name: "mixed.png", threshold: 128, scale: { pixels: 100, microns: 500 } });
  check("上传 mixed.png → 201", r.status === 201, r.data);
  const mixed = r.data.analysis;
  check("mixed 阈值128 → 4 颗粒", mixed.result.grainCount === 4, mixed.result);
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { threshold: 40 });
  check("阈值改 40 → 2 颗粒", r.status === 200 && r.data.analysis.result.grainCount === 2, r.data);
  const meanAt40 = r.data.analysis.result.meanDiameterUm;
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { scale: { pixels: 50, microns: 500 } });
  check("标尺改 50px=500µm → 粒径翻倍", r.status === 200 && Math.abs(r.data.analysis.result.meanDiameterUm - meanAt40 * 2) < 0.02, [r.data.analysis.result?.meanDiameterUm, meanAt40]);
  check("颗粒数不受标尺影响", r.data.analysis.result.grainCount === 2);

  // ---------- 失败回滚 ----------
  console.log("\n[失败回滚]");
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { threshold: 300 });
  check("非法阈值 → 400", r.status === 400 && r.data.error === "threshold_invalid", r.data);
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  const mixedAfter = r.data.find(a => a.id === mixed.id);
  check("旧结果保留（阈值仍 40）", mixedAfter.threshold === 40 && mixedAfter.result.grainCount === 2, mixedAfter);
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { scale: { pixels: -5, microns: 500 } });
  check("非法标尺 → 400 scale_required", r.status === 400 && r.data.error === "scale_required", r.data);
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  check("标尺未被破坏", r.data.find(a => a.id === mixed.id).scale.pixels === 50);
  // 原始图像丢失 → 重算失败且记录不变
  const mixedImgPath = join(uploadsDir, mixed.imageHash + ".png");
  const backup = join(workDir, "mixed-backup.png");
  await copyFile(mixedImgPath, backup);
  await rm(mixedImgPath);
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { threshold: 100 });
  check("图像缺失 → 409 image_missing", r.status === 409 && r.data.error === "image_missing", r.data);
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  const mixedAfter2 = r.data.find(a => a.id === mixed.id);
  check("记录回滚保持阈值 40", mixedAfter2.threshold === 40 && mixedAfter2.result.grainCount === 2, mixedAfter2);
  await copyFile(backup, mixedImgPath);
  r = await req("PATCH", `/api/analyses/${mixed.id}`, { threshold: 100 });
  check("图像恢复后可重算", r.status === 200 && r.data.analysis.threshold === 100, r.data);

  // ---------- 并发 ----------
  console.log("\n[并发]");
  const c = await req("POST", "/api/samples", { project: "并发矿", borehole: "ZK-9", coreBox: "B-9", depth: "30m", owner: "测试", sliceId: "SL-C1", method: "单偏光" });
  const csid = c.data.id;
  await req("POST", `/api/samples/${csid}/slices/SL-C1/logs`, { step: "观察", note: "完成" });
  const sameImagePosts = await Promise.all(Array.from({ length: 8 }, () =>
    req("POST", `/api/samples/${csid}/slices/SL-C1/analyses`, { image: fixtures["grains.png"].dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } })
  ));
  check("8 并发同图上传全部成功", sameImagePosts.every(x => x.status === 200 || x.status === 201), sameImagePosts.map(x => x.status));
  check("恰好 1 条 201", sameImagePosts.filter(x => x.status === 201).length === 1, sameImagePosts.map(x => x.status));
  r = await req("GET", `/api/samples/${csid}/slices/SL-C1/analyses`);
  check("同图并发后仅 1 条记录", r.data.length === 1, r.data.length);
  const mixedImagePosts = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    req("POST", `/api/samples/${csid}/slices/SL-C1/analyses`, { image: (i % 2 ? fixtures["mixed.png"] : fixtures["grains.png"]).dataUrl, threshold: 128, scale: { pixels: 100, microns: 500 } })
  ));
  check("6 并发两图交替全部成功", mixedImagePosts.every(x => x.status === 200 || x.status === 201));
  r = await req("GET", `/api/samples/${csid}/slices/SL-C1/analyses`);
  check("两图并发后共 2 条记录", r.data.length === 2, r.data.length);

  // 并发 PATCH 期间 GET 始终读到完整结果
  const target = r.data[0];
  const targetId = target.id;
  const targetFixture = Object.keys(fixtures).find(name =>
    createHash("sha256").update(fixtures[name].buf).digest("hex") === target.imageHash
  );
  check("目标记录可映射到测试图像", !!targetFixture, target.imageHash);
  const patchStorm = Array.from({ length: 20 }, (_, i) =>
    req("PATCH", `/api/analyses/${targetId}`, { threshold: i % 2 ? 40 : 128 })
  );
  let getsComplete = true;
  for (let i = 0; i < 30; i++) {
    const g = await req("GET", `/api/samples/${csid}/slices/SL-C1/analyses`);
    const rec = g.data.find(a => a.id === targetId);
    const ok = rec && typeof rec.result.grainCount === "number" && Array.isArray(rec.result.distribution)
      && typeof rec.result.areaFraction === "number"
      && rec.result.grainCount === localExpect(targetFixture, rec.threshold, rec.polarity, rec.scale.umPerPx).grainCount;
    if (!ok) { getsComplete = false; break; }
  }
  const stormResults = await Promise.all(patchStorm);
  check("20 并发 PATCH 全部 200", stormResults.every(x => x.status === 200), stormResults.map(x => x.status));
  check("PATCH 风暴期间 GET 始终完整且自洽", getsComplete);
  r = await req("GET", `/api/samples/${csid}/slices/SL-C1/analyses`);
  const finalRec = r.data.find(a => a.id === targetId);
  const finalExpect = localExpect(targetFixture, finalRec.threshold, finalRec.polarity, finalRec.scale.umPerPx);
  check("风暴平息后结果与参数自洽", finalRec.result.grainCount === finalExpect.grainCount, [finalRec.result.grainCount, finalExpect.grainCount]);

  // ---------- 重启保留 ----------
  console.log("\n[重启保留]");
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  const beforeRestart = r.data;
  check("重启前 SL-T1 有 2 条分析", beforeRestart.length === 2, beforeRestart.length);
  await stopServer();
  await startServer();
  r = await req("GET", `/api/samples/${sid}/slices/SL-T1/analyses`);
  check("重启后分析记录仍在", r.status === 200 && r.data.length === 2 && r.data.every(a => beforeRestart.some(b => b.id === a.id && b.result.grainCount === a.result.grainCount)), r.data);
  const hash = beforeRestart[0].imageHash;
  const imgRes = await fetch(`${base}/uploads/${hash}.png`);
  check("重启后图像文件可访问", imgRes.status === 200 && imgRes.headers.get("content-type") === "image/png", imgRes.status);
  const dbOnDisk = JSON.parse(await readFile(dataFile, "utf8"));
  check("磁盘数据含 analyses 与 samples", Array.isArray(dbOnDisk.analyses) && dbOnDisk.analyses.length >= 3 && dbOnDisk.samples.length >= 3, { analyses: dbOnDisk.analyses?.length, samples: dbOnDisk.samples?.length });
  r = await req("GET", "/api/samples");
  check("重启后旧样本接口正常", r.status === 200 && r.data.some(s => s.id === sid));

  // ---------- 旧入口回归 ----------
  console.log("\n[旧入口回归]");
  const page = await fetch(base + "/");
  const html = await page.text();
  check("首页 200 且含旧表单", page.status === 200 && html.includes("创建岩芯样本") && html.includes("薄片显微图像分析"));
  r = await req("POST", `/api/samples/${sid}/deliver`, {});
  check("标记交付", r.status === 200 && r.data.delivery === "已交付" && r.data.status === "已交付", r.data?.status);
  r = await req("POST", `/api/samples/NOPE/slices`, { id: "X" });
  check("旧 404 行为保持", r.status === 404 && r.data.error === "sample_not_found", r.data);
} catch (error) {
  failed++;
  console.error("FATAL", error);
} finally {
  await stopServer();
  await rm(workDir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
