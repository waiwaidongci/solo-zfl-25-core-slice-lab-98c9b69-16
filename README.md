# 岩芯样本切片实验室

运行：

```bash
npm start
```

访问`http://localhost:3025`。支持样本创建、切片任务、步骤记录、交付统计，以及薄片显微图像粒度与矿物统计。

## 薄片显微图像粒度与矿物统计

- 切片推进到「观察」步骤后，卡片内出现图像分析面板，可上传 PNG 薄片图像。
- 按颜色阈值（0–255，可选暗色/亮色颗粒为矿物）二值化，提取 8 连通颗粒，统计：
  - 颗粒数、矿物面积占比；
  - 等效圆粒径的平均 / 中位 / 最小 / 最大值；
  - 8 档粒径分布（数量与面积）。
- 填写标尺（N 像素 = M µm）后换算真实单位；修改阈值或标尺可在记录上直接重算。
- 校验与拒绝（均附说明）：空图、非 PNG、尺寸异常（宽高需 8–2048 像素）、未标尺校准、阈值越界、切片未完成观察。
- 同一图像（按 SHA-256）重复分析只保留一条记录，重复上传按新参数重算。
- 图像存于 `data/uploads/`，分析记录存于 `data/core-slices.json`（原子写入），重启后仍在。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/samples/:sid/slices/:slid/analyses` | 上传并分析。Body：`{image(dataURL/base64), name?, threshold, polarity?, scale:{pixels,microns}, mineral?}`；同一图像重复上传返回 `200 {deduplicated:true}` 并就地重算 |
| `GET` | `/api/samples/:sid/slices/:slid/analyses` | 该切片的分析列表（均为完整结果） |
| `PATCH` | `/api/analyses/:id` | 修改 `threshold` / `polarity` / `scale` / `mineral` 并重算；校验失败或原图缺失时保留原结果 |
| `GET` | `/uploads/<sha256>.png` | 已上传图像 |

原有样本 / 切片 / 步骤 / 交付接口保持不变。

## 验证

```bash
npm test     # API 级：功能、去重、重算、拒绝场景、并发、失败回滚、重启保留
npm run e2e  # 真实浏览器（需先 cd e2e && npm i && npx playwright install chromium）
```

环境变量：`PORT`（默认 3025）、`DATA_FILE`、`UPLOADS_DIR`（测试用隔离目录）。
