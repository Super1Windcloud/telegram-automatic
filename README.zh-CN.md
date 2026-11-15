# telegram-automatic

Telegram 会话导出、文件夹整理与频道内容采集工具。完整配置说明见 [English README](README.md)。

## 第一阶段：采集、文字去重、导出 JSON

`scan` 先遍历指定文件夹内所有频道，按文字内容跨频道去重，再下载保留内容的图片，输出一个格式化 JSON 文件后结束，等待用户指定下一步。此阶段不调用模型，不执行 OCR、摘要或体重筛选，也不需要模型 API Key。

```powershell
# 预检：仅列出目标频道
npm run scan -- --dry-run

# 全量采集可访问历史
npm run scan

# 可选：每频道最近 10 条消息，相册保持完整
npm run scan -- --limit 10
```

原命令 `npm run scan-folder-weight` 现在是相同采集流程的兼容别名，不再自动分析。

命令自动读取工作目录下的 `.env`，需要 Node.js 20.12 或更新版本。首次使用可从 `.env.example` 复制，已有 `.env` 时直接修改：

```dotenv
TELEGRAM_SCAN_FOLDER="小姐"
TELEGRAM_SCAN_LIMIT=0
TELEGRAM_SCAN_SINCE=
TELEGRAM_SCAN_OUTPUT=weight-scan
TELEGRAM_SCAN_EXPORT_FILE=folder-content.json
TELEGRAM_SCAN_DRY_RUN=false
TELEGRAM_SCAN_IMAGE_MAX_MIB=15
TELEGRAM_SCAN_ALBUM_MAX_MIB=40
TELEGRAM_SCAN_DOWNLOAD_TIMEOUT_MS=60000
```

优先级：**命令行参数 > 系统环境变量 > `.env`**。文件夹名称必填；`LIMIT=0` 表示每个频道的全部可访问历史，`SINCE` 留空表示不限制日期。原有体重阈值及 API 超时配置暂不参与采集，`--below` 参数会报错，避免把采集误认为筛选。

默认输出：`weight-scan/folder-content.json`。`TELEGRAM_SCAN_EXPORT_FILE` 支持相对输出目录的 JSON 文件名或绝对 JSON 路径。输出目录已加入 Git 忽略，自定义路径也应排除在版本控制之外。

- 去重只依据每条消息或整个相册的合并文字：统一全角等 Unicode 兼容字符和空白后精确比较，不做模糊匹配，不进行 OCR 或图片比较。文字不同但图片相同的内容仍分别保留；无文字的图片消息/相册单独保留，避免全部被合并。
- 重复文字只存一份，`sources` 保留每个来源的频道、消息 ID、日期和链接；文字及图片取首次遇到的那份内容，不下载其他重复副本的图片。图片 SHA-256 只用于校验，不参与内容去重。
- 视频消息连同说明文字整条跳过，包括圆视频、动画和 MIME 为 `video/*` 的文件；混合相册保留其中其他消息的文字和图片。照片及图片文件导出为 Base64，包含 `mimeType`、`byteLength`、`sha256` 和 `messageId`，其他媒体不下载，但其文字仍可保留。
- 所有频道先完成文字去重，再下载保留记录的图片。JSON 分条写入，避免将全部 Base64 图片同时放入内存；去重所需的文字及来源元数据会保留在内存。单图和相册大小分别受 `.env` 中的 MiB 限制。
- JSON 包含 `stage: "collected"`、`nextStep: "awaiting_user"`、`records`、`stats`、`errors` 和 `complete`。图片失败时该记录带有 `imageErrors`；频道或图片失败会使 `complete` 为 false，保留部分 JSON 并返回非零退出状态，不会进入下一阶段。
- `--limit` 按每个频道计数，边界相册保持完整，可能略超条数/日期范围。日期按 UTC 解释，具体时间需带时区，例如 `2026-11-01T00:00:00+08:00`。导出中会记录实际请求范围。
- 仅采集文件夹中的频道，不扫描群聊/机器人，不跟随其他频道链接，不修改 Telegram 数据。已删除、无权限或隐藏的历史无法读取。每次运行重新读取历史和下载保留图片，不复用之前的模型缓存。
- 写入完成后用临时文件原子替换目标文件，扫描期间有相邻的 `.json.lock` 锁。异常中断后应确认进程已停止再删除旧锁；残留临时文件不代表完整 JSON。

## 验证

```powershell
npm run typecheck
npm run test:weight-scan
```
