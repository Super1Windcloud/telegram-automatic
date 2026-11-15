# telegram-automatic

Telegram 会话导出、文件夹整理与频道消息筛选工具。完整命令和配置说明见 [English README](README.md)。

## 文件夹体重筛选

复用 `folder_rules.json` 中现有 Telegram 会话和 `openai` 配置，读取指定文件夹中的所有频道，对消息文字做摘要，对静态图片做 OCR，再按指定体重阈值筛选。

命令会自动读取工作目录下的 `.env`，需要 Node.js 20.12 或更新版本。首次使用可复制 `.env.example`，已有 `.env` 时直接修改，避免覆盖本地配置：

```powershell
Copy-Item .env.example .env
```

```dotenv
TELEGRAM_SCAN_FOLDER="小姐"
TELEGRAM_SCAN_BELOW_JIN=95
TELEGRAM_SCAN_LIMIT=0
TELEGRAM_SCAN_SINCE=
TELEGRAM_SCAN_OUTPUT=weight-scan
TELEGRAM_SCAN_DRY_RUN=false
TELEGRAM_SCAN_IMAGE_MAX_MIB=15
TELEGRAM_SCAN_ALBUM_MAX_MIB=40
TELEGRAM_SCAN_REQUEST_TIMEOUT_MS=120000
```

优先级：**命令行参数 > 系统环境变量 > `.env`**。文件夹和体重阈值必须配置，不再硬编码于扫描器；其余项目可使用技术默认值。`TELEGRAM_SCAN_SINCE` 留空表示不限制日期，两个大小限制以 MiB 为单位，超时以毫秒为单位。`.env` 已加入 Git 忽略，`.env.example` 作为可提交模板。

```powershell
# 预检：仅列出目标频道，不读取消息、不调用模型
npm run scan-folder-weight -- --dry-run

# 小范围：每个频道最近 10 条消息，相册保持完整
npm run scan-folder-weight -- --limit 10

# 全量：使用 .env 中的文件夹及体重阈值
npm run scan-folder-weight

# 自定义时间范围和输出目录
npm run scan-folder-weight -- --folder 小姐 --since 2026-11-01 --below 95 --output weight-scan
```

默认输出位于 `weight-scan/`，已加入 Git 忽略：

| 文件 | 内容 |
| --- | --- |
| `matches.md` | 符合条件的摘要、原文、OCR、体重及来源链接 |
| `matches.jsonl` | 符合条件的结构化记录和体重证据 |
| `analysis.jsonl` | 所有已扫描内容及其判断结果 |
| `review.jsonl` | 单位缺失、范围值、冲突、OCR 不确定及处理失败的内容 |
| `summary.json` | 本次范围、计数、错误和完整性状态 |
| `cache/` | 成功的模型分析缓存，重复执行时自动复用 |

- `--limit 0` 表示全部历史，正数是每个频道的消息数；相册可能略超条数或时间边界。`--since` 日期按 UTC 解释，具体时间需带时区，例如 `2026-11-01T00:00:00+08:00`。
- 95 斤本身不匹配；45 公斤转换为 90 斤。体重只从原文和 OCR 的明确单位数值提取，摘要不参与判断，不从照片外观推断。`165/90/B` 等无标签、无单位数字不会自动匹配；明确标注“体重90”但缺单位的内容进入待核对。
- 同一相册合并分析，独立消息分别分析。多个不同体重、范围/约数、OCR 不确定的内容进入待核对，避免把不同人的信息混为一条匹配记录。带单位但没标注“体重”的数值也会被识别，需结合原文核对含义。
- 支持照片及以文件形式发送的 JPEG/PNG/WebP 图片；不识别视频、音频、贴纸或网页预览中的文字，不跟随链接读取其他频道。仅扫描文件夹内的频道，不扫描群聊和机器人，不修改 Telegram 数据。
- 模型必须支持图片输入。文字及图片会发送至配置的 API，每条消息/相册一次分析请求，全量可能耗时并产生费用。可通过 `openai.api_style` 指定 `chat` 或 `responses`；`auto` 仅在接口返回 404/405 时切换。
- OCR 和摘要可能有误，匹配结果保留原文、OCR、数值证据和来源链接。单图或相册超过 `.env` 中的大小限制、API 拒绝或解析失败都会记录错误；有执行失败时命令返回非零状态并保留部分报告。
- 同目录重跑会复用未变化的成功分析并重试失败项，按本次阈值和范围重建报告；需要保留多次报告时请指定不同输出目录。缓存可能保留旧消息内容，自定义输出目录也应加入 Git 忽略。
- `complete: true` 只代表本次请求范围没有执行错误，不代表 OCR 绝对准确，也不代表待核对内容已人工确认。已删除、无权限和被隐藏的历史无法读取。
- 扫描期间输出目录有 `.scan.lock` 锁；异常中断后，应确认旧进程已停止再移除锁文件。只读扫描的 `--dry-run` 表示仅列频道，配置文件中的 `dry_run` 用于原有的 Telegram 修改命令。

## 验证

```powershell
npm run typecheck
npm run test:weight-scan
```
