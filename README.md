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
- Export folder channel content as formatted JSON, deduplicated by text, with Base64 images and videos skipped

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
npm run scan -- --dry-run
npm run message-stats
npm run json-to-markdown
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
- `scan`: collect and deduplicate folder content, export JSON, then stop; `scan-folder-weight` is a compatibility alias
- `message-stats`: report the total history message count and individual channel counts for `TELEGRAM_SCAN_FOLDER`
- `json-to-markdown`: convert exported JSON text and images to Markdown locally, rendering extracted image files without source metadata
- `run`: execute the full workflow; skips reclassification if a classified file already exists

`npm run sync-folders` is kept as an alias for `npm run run`.
`npm run stats` and `npm run overlaps` are short aliases for the folder stats and folder overlap exports.

## Folder content scan

`scan` is a collection-only stage. It scans all selected channels first, deduplicates by message text across the entire folder, then downloads retained images and writes one formatted JSON file. It stops after export and waits for the user to specify the next step. It does not call a model, OCR images, summarize text or filter by weight. No model API key is required for this stage. `scan-folder-weight` is retained as an alias with the same collection-only behavior.

```powershell
# List channels without collecting content
npm run scan -- --dry-run

# Collect all accessible history using .env
npm run scan

# Optional bounded scan or different date range
npm run scan -- --limit 10
npm run scan -- --since 2026-11-01 --output weight-scan
```

Scan settings use **CLI flags > shell environment > .env**, with safe technical defaults for optional settings. `TELEGRAM_SCAN_FOLDER` is required. Existing `TELEGRAM_SCAN_BELOW_JIN` and `TELEGRAM_SCAN_REQUEST_TIMEOUT_MS` values are reserved for a later, explicitly requested analysis stage and are ignored by `scan`; `--below` is rejected.

| Environment variable | Example | Purpose |
| --- | --- | --- |
| `TELEGRAM_SCAN_FOLDER` | `小姐` | Exact folder name (required) |
| `TELEGRAM_SCAN_LIMIT` | `0` | Messages per channel; zero means all accessible history |
| `TELEGRAM_SCAN_SINCE` | empty | Optional ISO date/time cutoff |
| `TELEGRAM_SCAN_OUTPUT` | `weight-scan` | Output directory |
| `TELEGRAM_SCAN_EXPORT_FILE` | `folder-content.json` | JSON filename relative to the output directory, or an absolute JSON path |
| `TELEGRAM_SCAN_DRY_RUN` | `false` | `true` only lists channels |
| `TELEGRAM_SCAN_IMAGE_MAX_MIB` | `15` | Maximum single-image size in MiB |
| `TELEGRAM_SCAN_ALBUM_MAX_MIB` | `40` | Maximum retained image size per post/album in MiB |
| `TELEGRAM_SCAN_DOWNLOAD_TIMEOUT_MS` | `60000` | Timeout for downloading each image, in milliseconds |

The default export is `weight-scan/folder-content.json`, which is gitignored. Custom output paths should also be excluded from version control. The export has `stage: "collected"`, `nextStep: "awaiting_user"`, a `records` array, scan statistics, errors and a `complete` flag.

- Deduplication compares the complete merged text of each post/album after NFKC Unicode normalization and collapsing whitespace. It is an exact comparison after normalization, without fuzzy matching, OCR or image comparison. Distinct nonblank text remains distinct even when pictures are identical. Picture-only posts with no text are retained separately.
- Repeated text is stored once with all occurrences in `sources`, preserving channel IDs/titles, message IDs, dates and links. The first encountered copy supplies the retained text and images; alternative pictures in duplicates are not downloaded. An album is one logical post; independent messages are not concatenated.
- Video messages are skipped entirely, including their captions. Round videos, animations, and documents with a `video/*` MIME type are also skipped. A mixed album retains its other text and images. Photo attachments and image documents are exported; other media are not downloaded, but their message text can still be retained.
- Images are written as `base64` with `mimeType`, `byteLength`, `sha256` and `messageId`. Image checksums are for file integrity and do not affect deduplication. All channels are deduplicated before any images are downloaded. The JSON is written incrementally to avoid retaining every Base64 image in memory. Content metadata and source references remain in memory until export finishes.
- `--limit` applies per channel; a complete boundary album can exceed the limit/date cutoff. Dates use UTC; timestamps must include a timezone, e.g. `2026-11-01T00:00:00+08:00`. The current scan range is recorded in the export.
- Only channels currently belonging to the folder, including pinned channels, are selected. The script does not join channels, follow channel links, modify folders, send messages or mark them as read. Inaccessible, hidden and deleted history cannot be retrieved.
- Channel or image errors are retained in JSON with `complete: false`, and the process exits with a failure status. A complete result means the requested accessible range and retained images were exported without errors. Every run re-reads history and re-downloads retained images; it does not reuse model-analysis caches.
- A temporary file is atomically renamed to the final path after export; older exports remain available until then. A neighboring `.json.lock` file prevents concurrent writes to the same export. After an interrupted process, confirm it has stopped before removing its stale lock. A temporary file left by interruption is not a complete JSON export.

For Chinese instructions, see [README.zh-CN.md](README.zh-CN.md).

Verification:

```powershell
npm run typecheck
npm run test:weight-scan
```

## Folder message counts

```powershell
npm run message-stats
npm run message-stats -- --folder 小姐 --output weight-scan/message-stats.json
```

Defaults to `TELEGRAM_SCAN_FOLDER` and writes formatted JSON to `TELEGRAM_MESSAGE_STATS_OUTPUT`, or `<TELEGRAM_SCAN_OUTPUT>/message-stats.json` when unset. CLI `--folder` / `--output` override these settings. This is separate from `folder-stats`, which counts dialogs rather than messages.

Each channel's count comes from Telegram's history total (`getHistory` with a single-message page); it is not inferred from message IDs or page length. The folder total is the sum of its channel totals, including videos and repeated messages. Album items count as individual messages, and service messages are included as reported by Telegram. The command ignores scan limits, date filters, deduplication and media filters. It only covers accessible history in the folder's channels, including pinned channels, and does not download media or call a model.

Channels are queried separately, so results are not an atomic snapshot; `queriedAt` records each query time. On failure, that channel's `messageCount` and the overall `totalMessages` are `null`; `knownTotalMessages` sums only successful channels. The partial JSON is saved with `complete: false` and the command exits with an error. An empty folder produces a complete report with zero messages.

```powershell
npm run test:message-stats
```

## JSON content to Markdown

```powershell
# Convert scan output to a Markdown file in the same directory
npm run json-to-markdown

# Explicit paths
npm run json-to-markdown -- --input weight-scan/folder-content.json --output weight-scan/content.md
```

The default input follows `TELEGRAM_SCAN_OUTPUT` and `TELEGRAM_SCAN_EXPORT_FILE`; the default output replaces the input extension with `.md`. Optional `.env` settings `TELEGRAM_MARKDOWN_INPUT` and `TELEGRAM_MARKDOWN_OUTPUT` override those paths, and CLI `--input` / `--output` take precedence.

The converter reads `records[].text` and `records[].images`, preserving order and line breaks. Source channel/date/links are omitted from Markdown and remain in the input JSON. Image-bearing records are retained by default, including image-only records; text-only records are skipped unless explicitly enabled. Base64 images are decoded into a sibling `<Markdown filename>.assets/` directory. Each post's pictures share one HTML paragraph block, wrapping to fit the available width. Thumbnails default to 120px wide and preserve aspect ratio without cropping; click one to open the full image. Set `TELEGRAM_MARKDOWN_IMAGE_WIDTH` or `--image-width` to change the width. The Markdown reader must support HTML image blocks.

Move or share the image directory together with the Markdown file. Configure the directory with `TELEGRAM_MARKDOWN_ASSETS_DIR` or `--assets-dir`; relative values are resolved against the Markdown output directory, and the image directory must be on the same drive as the Markdown file.

For Zed compatibility, every image group is wrapped in a standalone `<p>` HTML block, with opening and closing tags on their own lines and no blank lines inside. Zed 1.28.1 parses HTML blocks separately from inline HTML; bare inline `<a><img></a>` markup can appear as text rather than images ([upstream issue](https://github.com/zed-industries/zed/issues/65751)). Keep the block wrapper when editing the generated file. Thumbnail width and image files are unchanged by this wrapper.

Markdown export defaults to image-bearing records only (`TELEGRAM_MARKDOWN_REQUIRE_IMAGES=true`); text-only records are skipped and section numbers remain consecutive. Use `TELEGRAM_MARKDOWN_REQUIRE_IMAGES=false` or `--include-text-only` to retain text-only records, or `--images-only` to enforce the filter. This filter does not modify the input JSON.

Supported image MIME types: JPEG, PNG, WebP, GIF, BMP, AVIF and SVG. Optional source SHA-256 and byte-length fields are checked before writing; invalid images cause conversion to fail. Identical image bytes of the same MIME type share one asset file without changing message deduplication or removing image references. Old image files are retained when rerunning the conversion.

An incomplete source export is labelled as such in the Markdown. Input must contain a `records` array with string `text` fields; output cannot overwrite the input JSON. Conversion is entirely local and does not run Telegram collection, OCR, summaries or weight filtering.

```powershell
npm run test:markdown
```

## Notes

- Exported dialog records now also include diagnostic fields such as `entityKind`, `peerType`, `chatType`, `inputPeerType`, `hasPublicUsername`, and `normalizedId`
- Dialogs pinned inside a custom Telegram folder are treated as filed, even when Telegram returns them only via that folder's `pinnedPeers`
- Private chats and bots are grouped by type before model classification
- Groups and channels are sent to the configured API for categorization
- Existing custom Telegram folders are cleared before new folders are created
- The classified output is persisted locally so the folder step can be rerun without calling the API again
