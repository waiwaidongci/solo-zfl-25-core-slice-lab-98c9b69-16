// 真实浏览器端到端验证：建档 → 推进到观察 → 错误场景 → 上传出统计 →
// 重复上传去重 → 修改阈值/标尺重算 → 非法修改报错且旧结果保留 →
// 旧入口（交付）→ 重启后页面仍显示完整结果。
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fixtures = join(root, "test", "fixtures");
const PORT = 3199;
const base = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok -", name); }
  else { failed++; console.error("  FAIL -", name, extra === undefined ? "" : String(extra).slice(0, 300)); }
}
async function waitFor(fn, timeout = 9000, interval = 150) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, interval));
  }
  throw lastErr || new Error("waitFor timeout");
}

let server = null;
const workDir = await mkdtemp(join(tmpdir(), "slice-e2e-"));
async function startServer() {
  server = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: join(workDir, "data.json"), UPLOADS_DIR: join(workDir, "uploads") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 10000);
    server.stdout.on("data", d => { if (d.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
  });
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  server = null;
}

let browser = null;
try {
  await startServer();
  const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.on("pageerror", e => console.error("[pageerror]", e.message));
  await mkdir(join(__dirname, "shots"), { recursive: true });

  // ---------- 旧入口：建档 ----------
  console.log("\n[浏览器：建档与推进]");
  await page.goto(base + "/", { waitUntil: "networkidle" });
  check("页面标题", (await page.title()) === "岩芯样本切片实验室");
  await page.fill('input[name="project"]', "西沟金矿薄片");
  await page.fill('input[name="borehole"]', "ZK-88");
  await page.fill('input[name="coreBox"]', "BX-21");
  await page.fill('input[name="depth"]', "45.2-45.6m");
  await page.fill('input[name="owner"]', "王工");
  await page.fill('input[name="sliceId"]', "SL-E2E-1");
  await page.fill('input[name="method"]', "单偏光");
  await page.click('#form button');
  const card = page.locator(".card", { hasText: "西沟金矿薄片" });
  await waitFor(() => card.count());
  check("样本卡片出现", await card.count() === 1);
  check("分析面板在未观察时不出现", await card.locator(".analysis").count() === 0);

  // ---------- 推进到观察 ----------
  await card.locator("select[data-step]").selectOption("观察");
  await card.locator("textarea[data-note]").fill("镜下见浸染状黄铜矿");
  await card.locator("button[data-log]").click();
  await waitFor(() => card.locator(".analysis").count());
  check("观察完成后出现分析面板", await card.locator(".analysis").count() === 1);

  // ---------- 错误场景 ----------
  console.log("\n[浏览器：错误场景]");
  const errBox = card.locator("[data-err]");
  await card.locator("button[data-upload]").click();
  await waitFor(async () => (await errBox.textContent())?.includes("图像为空"));
  check("空图拒绝并说明", (await errBox.textContent()).includes("图像为空"));

  await card.locator('input[type="file"]').setInputFiles(join(fixtures, "grains.png"));
  await card.locator("button[data-upload]").click();
  await waitFor(async () => (await errBox.textContent())?.includes("标尺"));
  check("未标尺拒绝并说明", (await errBox.textContent()).includes("未进行标尺校准"));

  await card.locator('input[type="file"]').setInputFiles(join(fixtures, "tiny.png"));
  await card.locator("button[data-upload]").click();
  await waitFor(async () => (await errBox.textContent())?.includes("尺寸异常"));
  check("尺寸异常拒绝并说明", (await errBox.textContent()).includes("尺寸异常"));

  await card.locator('input[type="file"]').setInputFiles(join(fixtures, "not-a-png.png"));
  await card.locator("button[data-upload]").click();
  await waitFor(async () => (await errBox.textContent())?.includes("无法解析"));
  check("非 PNG 拒绝并说明", (await errBox.textContent()).includes("无法解析"));
  check("错误场景后无分析卡片", await card.locator(".an-card").count() === 0);

  // ---------- 上传、校准、统计 ----------
  console.log("\n[浏览器：上传与统计]");
  await card.locator('input[type="file"]').setInputFiles(join(fixtures, "grains.png"));
  await card.locator("[data-px]").fill("100");
  await card.locator("[data-um]").fill("500");
  await card.locator("[data-th]").fill("128");
  await card.locator("button[data-upload]").click();
  await waitFor(() => card.locator(".an-card").count());
  check("分析卡片出现", await card.locator(".an-card").count() === 1);
  const grainCell = card.locator(".an-stats div", { hasText: "颗粒数" });
  check("颗粒数=5", (await grainCell.locator("strong").textContent()).trim() === "5", await grainCell.textContent());
  const fracCell = card.locator(".an-stats div", { hasText: "面积占比" });
  check("面积占比显示百分数", /[\d.]+%/.test(await fracCell.textContent()), await fracCell.textContent());
  check("粒径分布条渲染", await card.locator(".bar-row").count() === 8);
  const imgOk = await card.locator(".an-card img").evaluate(el => el.complete && el.naturalWidth > 0);
  check("薄片图像可显示", imgOk);
  check("标尺信息回显", (await card.locator(".an-card").textContent()).includes("100px=500µm"));
  await page.screenshot({ path: join(__dirname, "shots", "1-upload.png"), fullPage: true });

  // ---------- 重复上传只保留一次 ----------
  console.log("\n[浏览器：去重]");
  await card.locator('input[type="file"]').setInputFiles(join(fixtures, "grains.png"));
  await card.locator("button[data-upload]").click();
  await waitFor(async () => (await errBox.textContent())?.includes("同一图像"));
  check("重复上传提示去重", (await errBox.textContent()).includes("同一图像已存在"));
  await page.waitForTimeout(400);
  check("仍只有 1 张分析卡片", await card.locator(".an-card").count() === 1);

  // ---------- 修改阈值重算 ----------
  console.log("\n[浏览器：修改重算]");
  await card.locator(".an-edit summary").click();
  await card.locator("[data-e-th]").fill("30");
  await card.locator("button[data-recalc]").click();
  await waitFor(async () => (await grainCell.locator("strong").textContent()).trim() === "2");
  check("阈值 128→30 重算后颗粒数=2", (await grainCell.locator("strong").textContent()).trim() === "2");
  // 修改标尺：100px=500µm → 200px=500µm，粒径应减半
  const meanBefore = parseFloat((await card.locator(".an-stats div", { hasText: "平均粒径" }).locator("strong").textContent()));
  await card.locator(".an-edit summary").click();
  await card.locator("[data-e-px]").fill("200");
  await card.locator("button[data-recalc]").click();
  await waitFor(async () => {
    const v = parseFloat((await card.locator(".an-stats div", { hasText: "平均粒径" }).locator("strong").textContent()));
    return Math.abs(v - meanBefore / 2) < 0.01;
  });
  check("标尺修改后粒径按比换算", true);
  await page.screenshot({ path: join(__dirname, "shots", "2-recalc.png"), fullPage: true });

  // ---------- 非法修改：报错且旧结果保留 ----------
  await card.locator(".an-edit summary").click();
  await card.locator("[data-e-th]").fill("999");
  await card.locator("button[data-recalc]").click();
  const editErr = card.locator("[data-e-err]");
  await waitFor(async () => (await editErr.textContent())?.includes("阈值"));
  check("非法阈值报错", (await editErr.textContent()).includes("0–255"));
  check("旧结果仍完整显示", (await grainCell.locator("strong").textContent()).trim() === "2");
  await page.screenshot({ path: join(__dirname, "shots", "3-invalid.png"), fullPage: true });

  // ---------- 旧入口：交付 ----------
  console.log("\n[浏览器：旧入口]");
  await card.locator("button[data-deliver]").click();
  await waitFor(async () => (await card.locator(".pill").textContent()) === "已交付");
  check("标记交付", (await card.locator(".pill").textContent()) === "已交付");
  const statsText = await page.locator("#stats").textContent();
  check("状态统计行更新", statsText.includes("已交付"));

  // ---------- 重启后页面仍显示完整结果 ----------
  console.log("\n[浏览器：重启保留]");
  await stopServer();
  await startServer();
  await page.reload({ waitUntil: "networkidle" });
  const card2 = page.locator(".card", { hasText: "西沟金矿薄片" });
  await waitFor(() => card2.locator(".an-card").count());
  check("重启后分析卡片仍在", await card2.locator(".an-card").count() === 1);
  check("重启后颗粒数仍为 2", (await card2.locator(".an-stats div", { hasText: "颗粒数" }).locator("strong").textContent()).trim() === "2");
  check("重启后分布条仍在", await card2.locator(".bar-row").count() === 8);
  const imgOk2 = await card2.locator(".an-card img").evaluate(el => el.complete && el.naturalWidth > 0);
  check("重启后图像仍可显示", imgOk2);
  await page.screenshot({ path: join(__dirname, "shots", "4-after-restart.png"), fullPage: true });
} catch (error) {
  failed++;
  console.error("FATAL", error);
} finally {
  if (browser) await browser.close();
  await stopServer();
  await rm(workDir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
