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

## 文件夹及各频道消息数量

```powershell
# 统计 .env 中 TELEGRAM_SCAN_FOLDER 对应文件夹
npm run message-stats

# 可选：指定文件夹和 JSON 输出路径
npm run message-stats -- --folder 小姐 --output weight-scan/message-stats.json
```

终端显示各频道的消息数和文件夹合计，同时输出格式化 JSON。默认路径为 `weight-scan/message-stats.json`，可通过 `TELEGRAM_MESSAGE_STATS_OUTPUT` 指定文件路径；未配置时使用 `TELEGRAM_SCAN_OUTPUT` 目录。命令行参数优先。

统计采用 Telegram 返回的各频道历史消息总数，不使用最大消息 ID 或当前页条数推算。包含视频、重复消息和 Telegram 总数中的服务消息，相册按每条消息计数；不受扫描条数、日期、去重和媒体筛选影响。仅统计文件夹中的频道及当前账号可访问的历史，不下载媒体、不调用模型。已有 `folder-stats` 统计的是会话数，与此命令不同。

各频道分别查询并记录 `queriedAt`，不保证同一时刻的原子快照。失败频道的 `messageCount` 为 null，整体 `totalMessages` 也为 null，已成功统计的数量放在 `knownTotalMessages`；保存 `complete: false` 的部分报告并返回非零状态。空文件夹输出 0。

## JSON 图文转换为 Markdown

```powershell
# 默认读取扫描结果，在同目录生成同名 .md 文件
npm run json-to-markdown

# 自定义输入、输出路径
npm run json-to-markdown -- --input weight-scan/folder-content.json --output weight-scan/content.md
```

默认输入继承 `TELEGRAM_SCAN_OUTPUT` 和 `TELEGRAM_SCAN_EXPORT_FILE`，默认输出将输入扩展名改为 `.md`。也可以在 `.env` 中设置 `TELEGRAM_MARKDOWN_INPUT` 和 `TELEGRAM_MARKDOWN_OUTPUT`，命令行 `--input` / `--output` 优先。

转换 `records[].text` 和 `records[].images`，保持内容顺序和原文换行；Markdown 不显示来源频道名称和链接，发布日期单独标注，完整来源仍保留在输入 JSON 中。Base64 图片会解码到 Markdown 旁的同名 `.assets/` 目录。同一条内容中的图片在一个段落内并排排列，空间不足时自动换行，默认宽 120px，保持比例、不裁剪，点击缩略图可查看原图。此排版需要 Markdown 阅读器支持内嵌 HTML 图片。

缩略图宽度可在 `.env` 中设置 `TELEGRAM_MARKDOWN_IMAGE_WIDTH=120`，或通过 `--image-width 96` 临时覆盖。纯图片条目也会保留，默认跳过没有图片的条目。移动或分享 Markdown 时，需要同时携带图片目录。

为兼容 Zed，每组图片放在独立的 `<p>` HTML 块内，开始和结束标签各占一行，内部不插入空行。Zed 1.28.1 对 HTML 块与行内 HTML 使用不同解析路径，裸写 `<a><img></a>` 可能显示为标签文本（[上游问题](https://github.com/zed-industries/zed/issues/65751)）。手动编辑时请保留段落容器；宽度配置和原图文件不受影响。

图片目录可通过 `.env` 的 `TELEGRAM_MARKDOWN_ASSETS_DIR` 或 `--assets-dir` 指定；相对目录以 Markdown 所在目录为基准，图片和 Markdown 必须位于同一驱动器。例如默认生成 `weight-scan/folder-content.md` 和 `weight-scan/folder-content.assets/`。

支持 JPEG、PNG、WebP、GIF、BMP、AVIF、SVG。会校验 Base64 及原始 JSON 中可选的 SHA-256、字节数；图片数据损坏时转换报错。同类型、同内容的图片复用一个文件，但不会合并消息或减少图片引用；重跑不会删除旧图片文件。

默认启用 `TELEGRAM_MARKDOWN_REQUIRE_IMAGES=true`，Markdown 只保留带图片的内容，过滤纯文字条目并重新连续编号；不会修改输入 JSON。设置为 `false` 或使用 `--include-text-only` 可保留纯文字，`--images-only` 可强制启用图片筛选。

每条图文显示“发布日期”，取 `sources[0].date`，对应保留的那份原消息和图片，不混用其他重复转载的日期。默认按 `Asia/Shanghai` 显示，可用 `TELEGRAM_MARKDOWN_TIMEZONE` 或 `--timezone` 调整。缺失或无效的日期标为“未知”，来源频道名称和链接不显示。

原始 JSON 的 `complete` 为 false 时会在文档中注明采集未完成。输入必须包含带字符串 `text` 字段的 `records` 数组，输出路径不能覆盖输入 JSON。

转换完全离线，不重新采集、不调用 Telegram、OCR 或模型，也不做体重筛选。

## 验证

```powershell
npm run typecheck
npm run test:weight-scan
npm run test:markdown
npm run test:message-stats
```
