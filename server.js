import http from "node:http";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "./png.js";
import { analyzeGrains } from "./analysis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATA_FILE || join(__dirname, "data", "core-slices.json");
const uploadsDir = process.env.UPLOADS_DIR || join(__dirname, "data", "uploads");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
const MIN_DIM = 8;
const MAX_DIM = 2048;
const MAX_BODY = 40 * 1024 * 1024;

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] },
        { id: "SL-001-B", method: "单偏光", observation: "见星点状金属矿物，待图像统计", status: "观察", logs: [{ at: "2026-06-12T10:05:00.000Z", step: "取样", note: "对应矿化段" }, { at: "2026-06-13T14:00:00.000Z", step: "切割", note: "完成" }, { at: "2026-06-14T09:30:00.000Z", step: "研磨", note: "0.03mm 标准薄片" }, { at: "2026-06-15T10:00:00.000Z", step: "观察", note: "镜下见星点状金属矿物" }] }
      ]
    }
  ],
  analyses: []
};

async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(db.analyses)) db.analyses = [];
  return db;
}

// 所有写操作串行化，避免并发请求交错导致丢数据或重复记录
let lockChain = Promise.resolve();
function withLock(task) {
  const result = lockChain.then(() => task());
  lockChain = result.catch(() => {});
  return result;
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, "payload_too_large", "请求体过大，请压缩图像后重试");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "bad_json", "请求体不是合法 JSON");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}
function findSlice(db, sampleId, sliceId) {
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) fail(404, "sample_not_found", "样本不存在");
  const slice = sample.slices.find(item => item.id === sliceId);
  if (!slice) fail(404, "slice_not_found", "切片不存在");
  return { sample, slice };
}
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 薄片图像分析：参数校验 ----
function parseThreshold(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) fail(400, "threshold_invalid", "颜色阈值需为 0–255 的整数");
  return n;
}
function parsePolarity(value) {
  return value === "light" ? "light" : "dark";
}
function parseScale(value) {
  if (!value || typeof value !== "object") fail(400, "scale_required", "未进行标尺校准：请填写标尺像素长度与对应实际长度");
  const pixels = Number(value.pixels);
  const microns = Number(value.microns);
  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(microns) || microns <= 0) {
    fail(400, "scale_required", "未进行标尺校准：标尺像素长度与实际长度（µm）需为正数");
  }
  return { pixels, microns, umPerPx: microns / pixels };
}
function parseImage(input) {
  if (!input || typeof input !== "string") fail(400, "image_required", "图像为空：请上传薄片显微图像（PNG）");
  const base64 = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
  const buf = Buffer.from(base64, "base64");
  if (!buf.length) fail(400, "image_required", "图像为空：请上传薄片显微图像（PNG）");
  let img;
  try {
    img = decodePng(buf);
  } catch (error) {
    const code = error && error.message;
    if (code === "chunk_crc_mismatch") {
      fail(400, "image_checksum_failed", "图像分块校验和错误：文件已损坏，请重新导出");
    }
    const structural = {
      missing_iend: "图像结构损坏：缺少 IEND 结束分块",
      ihdr_not_first: "图像结构损坏：IHDR 头部未位于文件起始",
      duplicate_ihdr: "图像结构损坏：出现重复的 IHDR 头部",
      idat_not_consecutive: "图像结构损坏：数据分块被其他分块隔开"
    };
    if (code && code.startsWith("unknown_critical_chunk")) {
      fail(400, "image_structure_invalid", "图像结构损坏：包含未知关键分块");
    }
    if (code && structural[code]) fail(400, "image_structure_invalid", structural[code]);
    fail(400, "image_decode_failed", "无法解析图像：仅支持非隔行扫描的 PNG 图像");
  }
  if (img.width < MIN_DIM || img.height < MIN_DIM || img.width > MAX_DIM || img.height > MAX_DIM) {
    fail(400, "image_size_abnormal", `图像尺寸异常：${img.width}×${img.height}，宽高需在 ${MIN_DIM}–${MAX_DIM} 像素之间`);
  }
  return { buf, img };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .analysis { border-top:1px dashed var(--line); padding-top:10px; display:grid; gap:8px; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .err { color:#b3261e; font-size:13px; } .err:empty { display:none; } .ok { color:#2e6b2e; font-size:13px; }
    .an-card { border:1px solid var(--line); border-radius:8px; padding:10px; display:grid; gap:8px; margin-top:8px; }
    .an-head { display:flex; gap:10px; align-items:flex-start; } .an-head img { width:96px; height:96px; object-fit:cover; border-radius:6px; border:1px solid var(--line); background:#f6f6f4; }
    .an-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; } .an-stats div { background:#f6f7f4; border-radius:6px; padding:8px; }
    .an-stats span { display:block; color:var(--muted); font-size:12px; } .an-stats strong { font-size:16px; }
    .bar-row { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
    .bar-label { width:110px; text-align:right; flex:none; } .bar-track { flex:1; background:#eef0ea; border-radius:4px; height:12px; overflow:hidden; }
    .bar-fill { display:block; height:100%; background:var(--accent); } .bar-count { width:36px; flex:none; }
    .an-edit summary { cursor:pointer; color:var(--accent); font-weight:700; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} .an-stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤、交付与薄片图像粒度统计</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    let samples = [];
    function esc(s) {
      return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function analysisPanelHtml(sampleId, sliceId) {
      const key = esc(sampleId + "|" + sliceId);
      return '<div class="analysis"><b>薄片显微图像分析</b>' +
        '<div class="meta">上传薄片图像，按颜色阈值提取矿物颗粒，统计粒径分布与面积占比</div>' +
        '<input type="file" accept="image/png" data-file="' + key + '">' +
        '<div class="row"><div><label>颜色阈值(0-255)</label><input type="number" min="0" max="255" value="128" data-th="' + key + '"></div>' +
        '<div><label>矿物颜色</label><select data-pol="' + key + '"><option value="dark">暗色颗粒</option><option value="light">亮色颗粒</option></select></div></div>' +
        '<div class="row"><div><label>标尺像素长度(px)</label><input type="number" min="1" placeholder="如 100" data-px="' + key + '"></div>' +
        '<div><label>对应实际长度(µm)</label><input type="number" min="0.01" step="any" placeholder="如 500" data-um="' + key + '"></div></div>' +
        '<button data-upload="' + key + '">上传并分析</button>' +
        '<div class="err" data-err="' + key + '"></div>' +
        '<div data-list="' + key + '"></div></div>';
    }
    function renderAnalysis(a) {
      const r = a.result;
      const maxCount = Math.max.apply(null, r.distribution.map(function(b){ return b.count; }).concat([1]));
      const bars = r.distribution.map(function(b){
        return '<div class="bar-row"><span class="bar-label">' + b.from + '–' + b.to + ' µm</span><span class="bar-track"><span class="bar-fill" style="width:' + Math.round(b.count / maxCount * 100) + '%"></span></span><span class="bar-count">' + b.count + '</span></div>';
      }).join("");
      return '<div class="an-card" data-an="' + esc(a.id) + '"><div class="an-head"><img src="' + esc(a.imageUrl) + '" alt="薄片图像"><div>' +
        '<b>' + esc(a.imageName || a.id) + '</b>' +
        '<div class="meta">' + a.width + '×' + a.height + ' · 阈值 ' + a.threshold + ' · ' + (a.polarity === "light" ? "亮色" : "暗色") + '颗粒 · 标尺 ' + a.scale.pixels + 'px=' + a.scale.microns + 'µm</div>' +
        '<div class="meta">更新于 ' + esc(a.updatedAt.replace("T", " ").slice(0, 19)) + '</div></div></div>' +
        '<div class="an-stats"><div><span>颗粒数</span><strong>' + r.grainCount + '</strong></div>' +
        '<div><span>矿物面积占比</span><strong>' + (r.areaFraction * 100).toFixed(1) + '%</strong></div>' +
        '<div><span>平均粒径</span><strong>' + r.meanDiameterUm + ' µm</strong></div>' +
        '<div><span>中位/最大</span><strong>' + r.medianDiameterUm + ' / ' + r.maxDiameterUm + ' µm</strong></div></div>' +
        '<div class="bars">' + (bars || '<div class="meta">阈值范围内无颗粒</div>') + '</div>' +
        '<details class="an-edit"><summary>修改阈值 / 标尺并重算</summary>' +
        '<div class="row"><div><label>颜色阈值</label><input type="number" min="0" max="255" value="' + a.threshold + '" data-e-th="' + esc(a.id) + '"></div>' +
        '<div><label>矿物颜色</label><select data-e-pol="' + esc(a.id) + '"><option value="dark"' + (a.polarity === "dark" ? " selected" : "") + '>暗色颗粒</option><option value="light"' + (a.polarity === "light" ? " selected" : "") + '>亮色颗粒</option></select></div></div>' +
        '<div class="row"><div><label>标尺像素长度(px)</label><input type="number" min="1" value="' + a.scale.pixels + '" data-e-px="' + esc(a.id) + '"></div>' +
        '<div><label>对应实际长度(µm)</label><input type="number" min="0.01" step="any" value="' + a.scale.microns + '" data-e-um="' + esc(a.id) + '"></div></div>' +
        '<button data-recalc="' + esc(a.id) + '">重新计算</button>' +
        '<div class="err" data-e-err="' + esc(a.id) + '"></div></details></div>';
    }
    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+esc(sample.project)+'</h3><span class="pill">'+esc(sample.status)+'</span><div class="meta">'+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+' · '+esc(sample.owner)+'</div><label>新增切片</label><input data-new-slice="'+esc(sample.id)+'" placeholder="切片编号"><input data-method="'+esc(sample.id)+'" placeholder="染色方法"><button data-add="'+esc(sample.id)+'">添加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+esc(slice.id)+'</b><div class="meta">'+esc(slice.method)+' · 当前步骤 '+esc(slice.status)+'</div><select data-step="'+esc(sample.id)+'|'+esc(slice.id)+'">'+steps.map(step => '<option>'+esc(step)+'</option>').join("")+'</select><textarea data-note="'+esc(sample.id)+'|'+esc(slice.id)+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+esc(sample.id)+'|'+esc(slice.id)+'">记录步骤</button><div class="meta">'+slice.logs.map(log => esc(log.step)+"："+esc(log.note)).join(" / ")+'</div>'+(slice.status === "观察" ? analysisPanelHtml(sample.id, slice.id) : '<div class="meta">完成「观察」步骤后可上传薄片显微图像进行粒度统计</div>')+'</div>').join("")+'<button data-deliver="'+esc(sample.id)+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); });
      document.querySelectorAll("[data-upload]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.upload.split("|");
        const key = sampleId + "|" + sliceId;
        const errBox = document.querySelector('[data-err="' + key + '"]');
        errBox.textContent = "";
        try {
          const fileInput = document.querySelector('[data-file="' + key + '"]');
          const file = fileInput.files[0];
          const image = file ? await fileToDataUrl(file) : "";
          const res = await api('/api/samples/' + sampleId + '/slices/' + sliceId + '/analyses', { method: 'POST', body: JSON.stringify({
            image: image,
            name: file ? file.name : "",
            threshold: Number(document.querySelector('[data-th="' + key + '"]').value),
            polarity: document.querySelector('[data-pol="' + key + '"]').value,
            scale: { pixels: Number(document.querySelector('[data-px="' + key + '"]').value), microns: Number(document.querySelector('[data-um="' + key + '"]').value) }
          }) });
          errBox.className = "ok";
          errBox.textContent = res.deduplicated ? "同一图像已存在，已按当前参数重算，仅保留一条记录" : "分析完成";
          fileInput.value = "";
          await loadAnalyses();
        } catch (e) {
          errBox.className = "err";
          errBox.textContent = e.message;
        }
      });
    }
    async function loadAnalyses() {
      for (const sample of samples) {
        for (const slice of sample.slices) {
          if (slice.status !== "观察") continue;
          const key = sample.id + "|" + slice.id;
          const box = document.querySelector('[data-list="' + key + '"]');
          if (!box) continue;
          try {
            const list = await api('/api/samples/' + sample.id + '/slices/' + slice.id + '/analyses');
            box.innerHTML = list.length ? list.map(renderAnalysis).join("") : '<div class="meta">暂无分析，请上传第一张薄片图像</div>';
          } catch (e) {
            box.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
          }
        }
      }
      document.querySelectorAll("[data-recalc]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.recalc;
        const errBox = document.querySelector('[data-e-err="' + id + '"]');
        errBox.textContent = "";
        try {
          await api('/api/analyses/' + id, { method: 'PATCH', body: JSON.stringify({
            threshold: Number(document.querySelector('[data-e-th="' + id + '"]').value),
            polarity: document.querySelector('[data-e-pol="' + id + '"]').value,
            scale: { pixels: Number(document.querySelector('[data-e-px="' + id + '"]').value), microns: Number(document.querySelector('[data-e-um="' + id + '"]').value) }
          }) });
          await loadAnalyses();
        } catch (e) { errBox.textContent = e.message; }
      });
    }
    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
    }
    async function load(){ samples = await api("/api/samples"); render(); await loadAnalyses(); }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, (await loadDb()).samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const created = await withLock(async () => {
        const db = await loadDb();
        let id = `CORE-${Date.now()}`;
        while (db.samples.some(item => item.id === id)) id += "r";
        const sample = { id, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
        updateSampleStatus(sample);
        db.samples.unshift(sample);
        await saveDb(db);
        return sample;
      });
      return sendJson(res, 201, created);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const input = await body(req);
      const updated = await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === addSlice[1]);
        if (!sample) fail(404, "sample_not_found", "样本不存在");
        sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
        updateSampleStatus(sample);
        await saveDb(db);
        return sample;
      });
      return sendJson(res, 201, updated);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      const updated = await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === logMatch[1]);
        if (!sample) fail(404, "sample_not_found", "样本不存在");
        const slice = sample.slices.find(item => item.id === logMatch[2]);
        if (!slice) fail(404, "slice_not_found", "切片不存在");
        slice.status = input.step;
        if (input.step === "观察") slice.observation = input.note || slice.observation;
        slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
        updateSampleStatus(sample);
        await saveDb(db);
        return sample;
      });
      return sendJson(res, 200, updated);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const updated = await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === deliverMatch[1]);
        if (!sample) fail(404, "sample_not_found", "样本不存在");
        sample.delivery = "已交付";
        updateSampleStatus(sample);
        await saveDb(db);
        return sample;
      });
      return sendJson(res, 200, updated);
    }

    // ---- 薄片显微图像粒度与矿物统计 ----
    const uploadMatch = url.pathname.match(/^\/uploads\/([a-f0-9]{64}\.png)$/);
    if (uploadMatch && req.method === "GET") {
      try {
        const data = await readFile(join(uploadsDir, uploadMatch[1]));
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        return res.end(data);
      } catch {
        return sendJson(res, 404, { error: "not_found" });
      }
    }
    const analysesMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/analyses$/);
    if (analysesMatch && req.method === "GET") {
      const db = await loadDb();
      const { sample, slice } = findSlice(db, analysesMatch[1], analysesMatch[2]);
      return sendJson(res, 200, db.analyses.filter(item => item.sampleId === sample.id && item.sliceId === slice.id));
    }
    if (analysesMatch && req.method === "POST") {
      const input = await body(req);
      const outcome = await withLock(async () => {
        const db = await loadDb();
        const { sample, slice } = findSlice(db, analysesMatch[1], analysesMatch[2]);
        if (slice.status !== "观察") fail(409, "slice_not_observed", "切片尚未完成观察，不能上传显微图像");
        const { buf, img } = parseImage(input.image);
        const threshold = parseThreshold(input.threshold);
        const polarity = parsePolarity(input.polarity);
        const scale = parseScale(input.scale);
        const result = analyzeGrains(img, { threshold, polarity, umPerPx: scale.umPerPx });
        const hash = createHash("sha256").update(buf).digest("hex");
        await mkdir(uploadsDir, { recursive: true });
        const imagePath = join(uploadsDir, `${hash}.png`);
        const tmpImagePath = `${imagePath}.${process.pid}.${Date.now()}.tmp`;
        const imageExisted = existsSync(imagePath);
        try {
          // 图像原子写入；记录保存失败时清理新写入的孤立文件，已有记录引用的文件不动
          await writeFile(tmpImagePath, buf);
          await rename(tmpImagePath, imagePath);
          const now = new Date().toISOString();
          const existing = db.analyses.find(item => item.sampleId === sample.id && item.sliceId === slice.id && item.imageHash === hash);
          if (existing) {
            Object.assign(existing, { threshold, polarity, scale, width: img.width, height: img.height, result, updatedAt: now });
            if (typeof input.name === "string" && input.name) existing.imageName = input.name.slice(0, 200);
            await saveDb(db);
            return { analysis: existing, deduplicated: true };
          }
          const analysis = {
            id: newId("AN"),
            sampleId: sample.id,
            sliceId: slice.id,
            imageHash: hash,
            imageUrl: `/uploads/${hash}.png`,
            imageName: typeof input.name === "string" ? input.name.slice(0, 200) : "",
            mineral: typeof input.mineral === "string" && input.mineral.trim() ? input.mineral.trim().slice(0, 50) : "未命名矿物",
            width: img.width,
            height: img.height,
            threshold,
            polarity,
            scale,
            result,
            createdAt: now,
            updatedAt: now
          };
          db.analyses.unshift(analysis);
          await saveDb(db);
          return { analysis, deduplicated: false };
        } catch (error) {
          await unlink(tmpImagePath).catch(() => {});
          if (!imageExisted) await unlink(imagePath).catch(() => {});
          if (error && error.status) throw error;
          fail(500, "save_failed", "保存分析记录失败，请重试");
        }
      });
      return sendJson(res, outcome.deduplicated ? 200 : 201, outcome);
    }
    const analysisMatch = url.pathname.match(/^\/api\/analyses\/([^/]+)$/);
    if (analysisMatch && req.method === "PATCH") {
      const input = await body(req);
      const analysis = await withLock(async () => {
        const db = await loadDb();
        const record = db.analyses.find(item => item.id === analysisMatch[1]);
        if (!record) fail(404, "analysis_not_found", "分析记录不存在");
        const threshold = input.threshold !== undefined ? parseThreshold(input.threshold) : record.threshold;
        const polarity = input.polarity !== undefined ? parsePolarity(input.polarity) : record.polarity;
        const scale = input.scale !== undefined ? parseScale(input.scale) : record.scale;
        let img;
        try {
          img = decodePng(await readFile(join(uploadsDir, `${record.imageHash}.png`)));
        } catch {
          fail(409, "image_missing", "原始图像缺失或损坏，无法重算；已保留原有统计结果");
        }
        const result = analyzeGrains(img, { threshold, polarity, umPerPx: scale.umPerPx });
        Object.assign(record, { threshold, polarity, scale, result, updatedAt: new Date().toISOString() });
        if (typeof input.mineral === "string" && input.mineral.trim()) record.mineral = input.mineral.trim().slice(0, 50);
        try {
          await saveDb(db);
        } catch {
          fail(500, "save_failed", "保存分析记录失败，请重试");
        }
        return record;
      });
      return sendJson(res, 200, { analysis, deduplicated: false });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.code || "internal_error", message: error.message });
  }
});

await mkdir(uploadsDir, { recursive: true });
server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
