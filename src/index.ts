import { TelegramClient, tl } from "@mtcute/node";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type NameRule = {
  title: string;
  emoji?: string;
  patterns: string[];
  color?: number;
};

type AppConfig = {
  apiId: number;
  apiHash: string;
  phone?: string;
  botToken?: string;
  password?: string;
  sessionStorage?: string;
  privateFolder: {
    title: string;
    emoji?: string;
    color?: number;
  };
  groupRules: NameRule[];
  uncategorizedFolder?: {
    title: string;
    emoji?: string;
    color?: number;
  };
};

type FolderSpec = {
  title: string;
  emoji?: string;
  color?: number;
  peerInputs: tl.TypeInputPeer[];
};

const CONFIG_PATH = resolve(process.cwd(), "telegram-folders.config.json");

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);

  if (!config.phone && !config.botToken) {
    throw new Error("配置缺少 phone 或 botToken，至少提供一个。");
  }

  const client = new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: config.sessionStorage ?? "telegram-automatic.session",
  });

  try {
    await client.start({
      phone: config.phone ? async () => config.phone! : undefined,
      botToken: config.botToken ? async () => config.botToken! : undefined,
      password: config.password ? async () => config.password! : undefined,
      code: () => client.input("请输入 Telegram 登录验证码: "),
      invalidCodeCallback: async (type) => {
        console.log(`${type === "code" ? "验证码" : "两步验证密码"}错误，请重新输入。`);
      },
      codeSentCallback: async (sentCode) => {
        console.log(`验证码已发送，方式: ${sentCode.type}`);
      },
    });

    const dialogs = await collectDialogs(client);
    const folderSpecs = buildFolderSpecs(config, dialogs);

    for (const spec of folderSpecs) {
      await upsertFolder(client, spec);
    }

    console.log(`同步完成，共处理 ${dialogs.length} 个会话，更新 ${folderSpecs.length} 个文件夹。`);
  } finally {
    await client.destroy();
  }
}

async function loadConfig(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AppConfig;

  if (!parsed.apiId || !parsed.apiHash) {
    throw new Error("配置中的 apiId/apiHash 不能为空。");
  }

  if (!parsed.privateFolder?.title) {
    throw new Error("配置中的 privateFolder.title 不能为空。");
  }

  if (!Array.isArray(parsed.groupRules)) {
    throw new Error("配置中的 groupRules 必须是数组。");
  }

  return parsed;
}

async function collectDialogs(client: TelegramClient) {
  const dialogs = [];

  for await (const dialog of client.iterDialogs({
    pinned: "keep",
    archived: "keep",
  })) {
    dialogs.push(dialog);
  }

  return dialogs;
}

function buildFolderSpecs(config: AppConfig, dialogs: Awaited<ReturnType<typeof collectDialogs>>): FolderSpec[] {
  const privatePeers: tl.TypeInputPeer[] = [];
  const groupedPeers = new Map<string, tl.TypeInputPeer[]>();

  for (const rule of config.groupRules) {
    groupedPeers.set(rule.title, []);
  }

  const uncategorizedPeers: tl.TypeInputPeer[] = [];

  for (const dialog of dialogs) {
    const peer = dialog.peer;
    const inputPeer = peer.inputPeer;

    if (inputPeer._ === "inputPeerEmpty") {
      continue;
    }

    if (peer.type === "user") {
      privatePeers.push(inputPeer);
      continue;
    }

    const name = normalizeName(peer.displayName);
    const matchedRule = config.groupRules.find((rule) => matchAnyPattern(name, rule.patterns));

    if (matchedRule) {
      groupedPeers.get(matchedRule.title)!.push(inputPeer);
    } else if (config.uncategorizedFolder) {
      uncategorizedPeers.push(inputPeer);
    }
  }

  const specs: FolderSpec[] = [
    {
      title: config.privateFolder.title,
      emoji: config.privateFolder.emoji,
      color: config.privateFolder.color,
      peerInputs: dedupeInputPeers(privatePeers),
    },
  ];

  for (const rule of config.groupRules) {
    specs.push({
      title: rule.title,
      emoji: rule.emoji,
      color: rule.color,
      peerInputs: dedupeInputPeers(groupedPeers.get(rule.title) ?? []),
    });
  }

  if (config.uncategorizedFolder) {
    specs.push({
      title: config.uncategorizedFolder.title,
      emoji: config.uncategorizedFolder.emoji,
      color: config.uncategorizedFolder.color,
      peerInputs: dedupeInputPeers(uncategorizedPeers),
    });
  }

  return specs;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function matchAnyPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();

    if (!trimmed) {
      return false;
    }

    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
      const lastSlash = trimmed.lastIndexOf("/");
      const source = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1) || "i";
      return new RegExp(source, flags).test(name);
    }

    return name.includes(trimmed.toLowerCase());
  });
}

function dedupeInputPeers(peers: tl.TypeInputPeer[]): tl.TypeInputPeer[] {
  const seen = new Set<string>();
  const result: tl.TypeInputPeer[] = [];

  for (const peer of peers) {
    const key = inputPeerKey(peer);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(peer);
  }

  return result;
}

function inputPeerKey(peer: tl.TypeInputPeer): string {
  switch (peer._) {
    case "inputPeerSelf":
    case "inputPeerEmpty":
      return peer._;
    case "inputPeerChat":
      return `${peer._}:${peer.chatId}`;
    case "inputPeerChannel":
      return `${peer._}:${peer.channelId}`;
    case "inputPeerUser":
      return `${peer._}:${peer.userId}`;
    case "inputPeerUserFromMessage":
      return `${peer._}:${peer.userId}:${peer.msgId}`;
    case "inputPeerChannelFromMessage":
      return `${peer._}:${peer.channelId}:${peer.msgId}`;
    default:
      return JSON.stringify(peer);
  }
}

async function upsertFolder(client: TelegramClient, spec: FolderSpec): Promise<void> {
  const existing = await client.findFolder({ title: spec.title });
  const folderPayload = toDialogFilter(spec, existing?.id);

  if (existing && existing._ === "dialogFilter") {
    await client.editFolder({
      folder: existing,
      modification: {
        title: folderPayload.title,
        emoticon: folderPayload.emoticon,
        color: folderPayload.color,
        pinnedPeers: folderPayload.pinnedPeers,
        includePeers: folderPayload.includePeers,
        excludePeers: folderPayload.excludePeers,
        contacts: folderPayload.contacts,
        nonContacts: folderPayload.nonContacts,
        groups: folderPayload.groups,
        broadcasts: folderPayload.broadcasts,
        bots: folderPayload.bots,
        excludeArchived: folderPayload.excludeArchived,
        excludeMuted: folderPayload.excludeMuted,
        excludeRead: folderPayload.excludeRead,
      },
    });
    console.log(`已更新文件夹: ${spec.title} (${spec.peerInputs.length} 个会话)`);
    return;
  }

  await client.createFolder(folderPayload);
  console.log(`已创建文件夹: ${spec.title} (${spec.peerInputs.length} 个会话)`);
}

function toDialogFilter(spec: FolderSpec, id?: number): tl.RawDialogFilter {
  return {
    _: "dialogFilter",
    id: id ?? 0,
    title: {
      _: "textWithEntities",
      text: spec.title,
      entities: [],
    },
    emoticon: spec.emoji,
    color: spec.color,
    contacts: false,
    nonContacts: false,
    groups: false,
    broadcasts: false,
    bots: false,
    excludeMuted: false,
    excludeRead: false,
    excludeArchived: false,
    pinnedPeers: [],
    includePeers: spec.peerInputs,
    excludePeers: [],
  };
}

main().catch((error) => {
  console.error("执行失败:", error);
  process.exitCode = 1;
});
