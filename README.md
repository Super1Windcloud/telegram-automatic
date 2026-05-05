# telegram-automatic

参考 `A:\Pycharm_Project\telegram-auto` 的 TypeScript 版实现，基于 `mtcute` 完成 Telegram 会话工作流：

- 导出所有会话到 `dialogs_snapshot.json`
- 调用 OpenAI 兼容接口做分类
- 把分类结果写回 Telegram 文件夹

## 配置

优先使用 `folder_rules.json`，也兼容当前仓库旧的 `telegram-folders.config.json`。

推荐先复制 Python 风格配置：

```powershell
Copy-Item folder_rules.example.json folder_rules.json
```

然后填写：

- `api_id`
- `api_hash`
- `phone`
- `session_name`
- `dry_run`
- `openai.base_url`
- `openai.api_key`
- `openai.model`
- `openai.batch_size`
- `rules`

也支持环境变量：

- `TELEGRAM_FOLDER_RULES`
- `TELEGRAM_DIALOG_SNAPSHOT`
- `TELEGRAM_CLASSIFIED_OUTPUT`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_API_STYLE`

## 命令

```powershell
npm run snapshot
npm run classify
npm run folders
npm run run
```

其中：

- `snapshot` 导出会话快照
- `classify` 读取快照并输出 `classified_dialogs.json`
- `folders` 根据分类结果重建 Telegram 文件夹
- `run` 执行完整流程，且已有分类结果时会跳过重复分类

`npm run sync-folders` 仍然保留，等同于 `npm run run`。

## 说明

- 私聊和机器人会优先按类型直接归组
- 群组和频道会走 OpenAI 分类
- 当接口返回不可解析内容时，会降级到本地规则分类
- 写入文件夹前会清空现有自定义文件夹，行为与参考 Python 项目一致
