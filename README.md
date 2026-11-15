# telegram-automatic

Utilities for exporting Telegram dialogs, classifying them with an OpenAI-compatible API, and rebuilding Telegram folders from the classification results.

## Features

- Export all dialogs to `dialogs_snapshot.json`
- Classify dialogs through an OpenAI-compatible API
- Rebuild Telegram folders from `classified_dialogs.json`
- Export dialogs that are not in any custom Telegram folder
- Export statistics for all current Telegram folders
- Export dialogs that belong to two or more custom Telegram folders
- Add dialogs from `unfiled_dialogs.json` to a named Telegram folder
- Fall back to local rules when model output cannot be parsed
- Support both a full workflow run and step-by-step commands
- Scan channel history in a Telegram folder, summarize text, OCR images, and export messages below a weight threshold

## Configuration

Commands automatically load `.env` from the working directory, using Node.js 20.12+ built-in environment parsing. Existing shell environment variables take precedence over `.env`. Copy `.env.example` to `.env` for scan settings; `.env` and local `.env.*` files are gitignored, while `.env.example` is committed.

```powershell
Copy-Item .env.example .env
```

The app looks for `folder_rules.json` first and also supports `telegram-folders.config.json` for compatibility.

Create a config file from the example:

```powershell
Copy-Item folder_rules.example.json folder_rules.json
```

Then fill in:

- `api_id`
- `api_hash`
- `phone`
- `session_name`
- `dry_run`（可被命令行 `--dry-run` / `--no-dry-run` 覆盖）
- `openai.base_url`
- `openai.api_key`
- `openai.model`
- `openai.batch_size`
- `openai.api_style`
- `rules`

Supported environment variables:

- `TELEGRAM_FOLDER_RULES`
- `TELEGRAM_DIALOG_SNAPSHOT`
- `TELEGRAM_CLASSIFIED_OUTPUT`
- `TELEGRAM_UNFILED_OUTPUT`
- `TELEGRAM_FOLDER_STATS_OUTPUT`
- `TELEGRAM_FOLDER_OVERLAPS_OUTPUT`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_API_STYLE`

## Commands

```powershell
npm run snapshot
npm run classify
npm run folders
npm run unfiled
npm run folder-stats
npm run folder-overlaps
npm run file-unfiled -- 目标文件夹名称
npm run archive-folder
npm run sync-private-folder
npm run clear-private-folder
npm run clear-private-folder -- --dry-run
npm run purge-deleted-users
npm run scan-folder-weight -- --dry-run
npm run run
```

Command summary:

- `snapshot`: export dialogs to `dialogs_snapshot.json`
- `classify`: read the snapshot and write `classified_dialogs.json`
- `folders`: rebuild Telegram folders from the classified output
- `unfiled`: export dialogs that are not included in any current custom Telegram folder
- `folder-stats`: export all current Telegram folder stats to `folder_stats.json`
- `folder-overlaps`: export dialogs that are included in two or more current custom Telegram folders to `folder_overlaps.json`
- `file-unfiled`: add dialogs from `unfiled_dialogs.json` to the specified folder; creates it if missing
- `archive-folder`: prompt for a custom Telegram folder name, then archive all dialogs currently included in that folder
- `sync-private-folder`: add unarchived private user dialogs that are not in any custom folder into the `私聊` folder
- `clear-private-folder`: delete dialogs that belong only to the `私聊` folder. Dialogs that also belong to another custom folder are skipped. Pass `--dry-run` to preview, or `--no-dry-run` to execute even when `dry_run` is true in the config file. The same flags apply to the other mutating commands.
- `purge-deleted-users`: delete dialogs for accounts that are already deleted or deactivated
- `scan-folder-weight`: read channels in a named folder, summarize posts, OCR images, and export weight matches (see below)
- `run`: execute the full workflow; skips reclassification if a classified file already exists

`npm run sync-folders` is kept as an alias for `npm run run`.
`npm run stats` and `npm run overlaps` are short aliases for the folder stats and folder overlap exports.

## Folder weight scan

The folder name and weight threshold are required settings, read from `TELEGRAM_SCAN_FOLDER` and `TELEGRAM_SCAN_BELOW_JIN` in `.env`, or supplied through `--folder` and `--below`. Neither business value is hardcoded in the scanner. Priority for scan options: **CLI flags > shell environment > `.env`**. Other scan options retain safe technical defaults when omitted.

| Environment variable | Value in `.env.example` | Purpose |
| --- | --- | --- |
| `TELEGRAM_SCAN_FOLDER` | `小姐` | Exact Telegram folder title (required) |
| `TELEGRAM_SCAN_BELOW_JIN` | `95` | Exclusive weight threshold, in jin (required) |
| `TELEGRAM_SCAN_LIMIT` | `0` | Messages per channel; zero means all accessible history |
| `TELEGRAM_SCAN_SINCE` | empty | Optional ISO date/time cutoff |
| `TELEGRAM_SCAN_OUTPUT` | `weight-scan` | Report and cache directory |
| `TELEGRAM_SCAN_DRY_RUN` | `false` | `true` lists channels only |
| `TELEGRAM_SCAN_IMAGE_MAX_MIB` | `15` | Maximum size of one image, in MiB |
| `TELEGRAM_SCAN_ALBUM_MAX_MIB` | `40` | Maximum total image size of an album, in MiB |
| `TELEGRAM_SCAN_REQUEST_TIMEOUT_MS` | `120000` | Timeout for each model request, in milliseconds |

Uses the existing Telegram user session and `openai` configuration. The model must support image inputs; the script sends message text and images to the configured API. Both Chat Completions and Responses are supported. `api_style: auto` tries Chat first and falls back to Responses only for an unavailable endpoint (404/405). For a custom gateway, set `api_style` explicitly if necessary. Image input follows the [official OpenAI documentation](https://developers.openai.com/api/docs/guides/images-vision).

```powershell
# List channels only, without reading messages or calling the model
npm run scan-folder-weight -- --dry-run

# Small initial scan: latest 10 messages per channel (complete albums included)
npm run scan-folder-weight -- --limit 10

# All accessible history using the folder and weight threshold configured in .env
npm run scan-folder-weight

# Optional folder, date, threshold and output directory
npm run scan-folder-weight -- --folder 小姐 --since 2026-11-01 --below 95 --output weight-scan
```

- The supplied `.env.example` selects folder `小姐` and threshold **< 95 jin** (95 itself is excluded), with no history limit. Change `.env` to select another folder or threshold. `--limit 0` means all accessible history; positive limits apply separately to each channel. Complete albums can exceed the limit or extend past the date cutoff. Dates use UTC; timestamps must include a timezone, e.g. `2026-11-01T00:00:00+08:00`.
- Only channels currently belonging to the folder are selected, including pinned channels. Group chats and bots are excluded. The command never joins channels, sends messages, changes folder membership, or marks messages as read. The configured session must already have access to the history.
- Text and static JPEG/PNG/WebP images are analyzed. Images sent as documents are supported. Each album is summarized together; unrelated posts are kept separate. Videos, audio, stickers, other documents and webpage previews are not OCRed. These omissions are recorded as media types where applicable. The scanner does not follow links to other channels.
- Weight is determined locally from explicit units in the original text and OCR, independently of the generated summary. `1 kg = 2 jin`; pounds are also converted. Unitless profiles such as `165/90/B`, unreadable text, ranges, qualified values, or conflicting weights are never automatically matched. Labelled unitless weights, OCR uncertainty and conflicts are exported for review. The script does not estimate weight from appearance or associate weights across separate posts.
- Model OCR and summaries can contain mistakes; source text, OCR, evidence and Telegram links are retained for verification. An explicit weight without a `weight` label is accepted, so review the context of each match. Each post/album makes one model request, with bounded retries for transient failures; a full history scan may take time and incur API costs. Images or albums exceeding the configured size limits, API refusals and parsing failures are recorded as failures rather than silently skipped.
- Successful analyses are cached locally by content and API/model settings. Rerunning re-reads Telegram history, reuses unchanged cached analyses, retries failures, and recalculates matches for the current threshold. It rebuilds reports for the current scan range, so use different output directories to keep separate reports. Cache files may retain older content. The output directory is locked while scanning; after an interrupted process, remove `.scan.lock` only after confirming that process has stopped.
- This read-only command uses `--dry-run` to list channels only; the configuration's `dry_run` setting applies to the existing Telegram-mutating commands. `--help` explains the scan options without logging in.

Default output directory: `weight-scan/` (gitignored). Custom output directories should also be excluded from version control.

| File | Content |
| --- | --- |
| `matches.md` | Readable matching posts: summary, original text, OCR, weight and source links |
| `matches.jsonl` | Matching records with structured weight evidence |
| `analysis.jsonl` | All scanned posts, including excluded, unknown, review and failed records |
| `review.jsonl` | Ambiguous weights, uncertain OCR and failed analyses |
| `summary.json` | Scan range, counts, errors and `complete` flag, checkpointed during the scan |
| `cache/` | Validated model outputs, reused on subsequent runs |

The command exits with a failure status if any channel or analysis fails. Partial reports are retained; `complete: true` indicates the requested range was processed without execution errors, including posts still needing human review. It does not certify OCR accuracy. Deleted, inaccessible or history-hidden messages cannot be retrieved. For Chinese usage notes, see [README.zh-CN.md](README.zh-CN.md).

Verification:

```powershell
npm run typecheck
npm run test:weight-scan
```

## Notes

- Exported dialog records now also include diagnostic fields such as `entityKind`, `peerType`, `chatType`, `inputPeerType`, `hasPublicUsername`, and `normalizedId`
- Dialogs pinned inside a custom Telegram folder are treated as filed, even when Telegram returns them only via that folder's `pinnedPeers`
- Private chats and bots are grouped by type before model classification
- Groups and channels are sent to the configured API for categorization
- Existing custom Telegram folders are cleared before new folders are created
- The classified output is persisted locally so the folder step can be rerun without calling the API again
