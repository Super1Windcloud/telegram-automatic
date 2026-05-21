# telegram-automatic

Utilities for exporting Telegram dialogs, classifying them with an OpenAI-compatible API, and rebuilding Telegram folders from the classification results.

## Features

- Export all dialogs to `dialogs_snapshot.json`
- Classify dialogs through an OpenAI-compatible API
- Rebuild Telegram folders from `classified_dialogs.json`
- Export dialogs that are not in any custom Telegram folder
- Export statistics for all current Telegram folders
- Export dialogs that belong to two or more custom Telegram folders
- Fall back to local rules when model output cannot be parsed
- Support both a full workflow run and step-by-step commands

## Configuration

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
- `dry_run`
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
npm run archive-folder
npm run sync-private-folder
npm run purge-deleted-users
npm run run
```

Command summary:

- `snapshot`: export dialogs to `dialogs_snapshot.json`
- `classify`: read the snapshot and write `classified_dialogs.json`
- `folders`: rebuild Telegram folders from the classified output
- `unfiled`: export dialogs that are not included in any current custom Telegram folder
- `folder-stats`: export all current Telegram folder stats to `folder_stats.json`
- `folder-overlaps`: export dialogs that are included in two or more current custom Telegram folders to `folder_overlaps.json`
- `archive-folder`: prompt for a custom Telegram folder name, then archive all dialogs currently included in that folder
- `sync-private-folder`: add unarchived private user dialogs that are not in any custom folder into the `私聊` folder
- `purge-deleted-users`: delete dialogs for accounts that are already deleted or deactivated
- `run`: execute the full workflow; skips reclassification if a classified file already exists

`npm run sync-folders` is kept as an alias for `npm run run`.
`npm run stats` and `npm run overlaps` are short aliases for the folder stats and folder overlap exports.

## Notes

- Exported dialog records now also include diagnostic fields such as `entityKind`, `peerType`, `chatType`, `inputPeerType`, `hasPublicUsername`, and `normalizedId`
- Dialogs pinned inside a custom Telegram folder are treated as filed, even when Telegram returns them only via that folder's `pinnedPeers`
- Private chats and bots are grouped by type before model classification
- Groups and channels are sent to the configured API for categorization
- Existing custom Telegram folders are cleared before new folders are created
- The classified output is persisted locally so the folder step can be rerun without calling the API again
