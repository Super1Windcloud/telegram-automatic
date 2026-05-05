import type { TelegramClient, tl } from "@mtcute/node";
import { dedupeInputPeers } from "./telegram.js";
import type { ClassificationPayload, DialogInfo } from "./types.js";

const CATEGORY_MERGE_MAP: Record<string, string> = {
  工具机器人: "工具",
  工具: "工具",
  娱乐: "娱乐",
  成人: "成人",
  成人交易: "成人",
  成人内容: "成人",
  成人娱乐: "成人",
  交易: "交易",
  资讯: "资讯",
  本地资讯: "资讯",
  资源: "资讯",
  学习: "资讯",
  移民: "资讯",
  本地群: "社群",
  朋友: "私聊",
  未分类: "未分类",
};

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }
  return "";
}

function isEditableFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter {
  return filter._ === "dialogFilter";
}

function mergeCategory(category: string, dialog: DialogInfo): string {
  if (CATEGORY_MERGE_MAP[category]) {
    return CATEGORY_MERGE_MAP[category];
  }
  if (dialog.types.includes("bot")) {
    return "工具";
  }
  if (dialog.types.includes("private")) {
    return "私聊";
  }
  if (dialog.types.includes("group") || dialog.types.includes("supergroup")) {
    return "社群";
  }
  if (dialog.types.includes("channel")) {
    return "资讯";
  }
  return "未分类";
}

function buildFolderPayload(spec: { title: string; peers: tl.TypeInputPeer[] }): tl.RawDialogFilter {
  return {
    _: "dialogFilter",
    id: 0,
    title: {
      _: "textWithEntities",
      text: spec.title,
      entities: [],
    },
    contacts: false,
    nonContacts: false,
    groups: false,
    broadcasts: false,
    bots: false,
    excludeMuted: false,
    excludeRead: false,
    excludeArchived: false,
    pinnedPeers: [],
    includePeers: spec.peers,
    excludePeers: [],
  };
}

async function listEditableFolders(client: TelegramClient): Promise<tl.RawDialogFilter[]> {
  const response = await client.getFolders();
  return response.filters.filter(isEditableFolder);
}

async function clearEditableFolders(client: TelegramClient, dryRun: boolean): Promise<void> {
  const existing = await listEditableFolders(client);
  if (existing.length === 0) {
    console.log("没有可移除的自定义文件夹。");
    return;
  }

  console.log(`准备移除 ${existing.length} 个现有自定义文件夹。`);
  for (const folder of existing.sort((left, right) => left.id - right.id)) {
    const title = titleText(folder) || `id=${folder.id}`;
    if (dryRun) {
      console.log(`[dry-run] 将移除文件夹 ${title}`);
      continue;
    }
    await client.deleteFolder(folder);
    console.log(`已移除文件夹 ${title}`);
  }
}

export async function applyClassifiedFolders(
  client: TelegramClient,
  dialogs: DialogInfo[],
  payload: ClassificationPayload,
  dryRun: boolean,
): Promise<void> {
  const byId = new Map(dialogs.map((dialog) => [dialog.id, dialog]));
  const groupedPeers = new Map<string, tl.TypeInputPeer[]>();

  for (const item of payload.results) {
    const dialog = byId.get(item.id);
    if (!dialog) {
      continue;
    }

    const category = mergeCategory(item.category.trim(), dialog);
    groupedPeers.set(category, [...(groupedPeers.get(category) ?? []), dialog.inputPeer]);
  }

  await clearEditableFolders(client, dryRun);
  console.log(`按合并大类写入 Telegram 文件夹，共 ${groupedPeers.size} 类。`);

  const sortedGroups = [...groupedPeers.entries()].sort((left, right) => {
    const sizeDiff = dedupeInputPeers(right[1]).length - dedupeInputPeers(left[1]).length;
    return sizeDiff !== 0 ? sizeDiff : left[0].localeCompare(right[0], "zh-CN");
  });

  for (const [category, peers] of sortedGroups) {
    const includePeers = dedupeInputPeers(peers);
    if (includePeers.length === 0) {
      console.log(`跳过文件夹 ${category}: 没有可用会话。`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] 将写入文件夹 ${category}: ${includePeers.length} 个会话`);
      continue;
    }

    await client.createFolder(buildFolderPayload({ title: category, peers: includePeers }));
    console.log(`创建文件夹 ${category}: ${includePeers.length} 个会话`);
  }
}
