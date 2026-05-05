# telegram-automatic

使用 `mtcute` 自动整理 Telegram 文件夹：

- 私聊统一放到一个文件夹
- 群组、频道、超级群合并处理
- 按会话名称规则自动分类到不同文件夹

## 1. 准备

从 `my.telegram.org` 获取：

- `apiId`
- `apiHash`

复制配置文件：

```powershell
Copy-Item telegram-folders.config.example.json telegram-folders.config.json
```

然后修改 `telegram-folders.config.json`：

- `phone`：你的 Telegram 手机号
- `password`：如果开了两步验证就填
- `privateFolder`：私聊目标文件夹
- `groupRules`：群组/频道/超级群的名称匹配规则
- `uncategorizedFolder`：可选，未命中的群会进入这里

`patterns` 支持两种写法：

- 普通包含匹配，例如 `"项目"`
- 正则表达式字符串，例如 `"/^dev/i"`

## 2. 运行

```powershell
npm run sync-folders
```

首次运行会要求输入登录验证码，并在当前目录生成 session 数据库。

## 3. 规则说明

实现逻辑：

- `peer.type === "user"` 的会话全部进入私聊文件夹
- `peer.type !== "user"` 的会话视为群/频道类会话
- 群/频道类会话按 `groupRules` 从上到下匹配，命中第一条规则后停止
- 没有命中时，若配置了 `uncategorizedFolder`，则放入该文件夹

## 4. 注意

- Telegram 文件夹标题有长度限制，建议控制在较短范围内
- 此脚本会覆盖它管理的这些文件夹里的 `includePeers` 内容
- 如果你手动往同名文件夹里加聊天，下次运行会被脚本结果覆盖
