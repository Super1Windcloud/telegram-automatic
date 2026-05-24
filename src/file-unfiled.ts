import { readFile } from "node:fs/promises";
import type { TelegramClient, tl } from "@mtcute/node";
import { dedupeInputPeers, type CollectedDialog } from "./telegram.js";
import type { UnfiledDialogsPayload } from "./types.js";

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }

  return "";
}

function isEditableFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter {
  return filter._ === "dialogFilter";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
}

function buildFolderPayload(title: string, peers: tl.TypeInputPeer[]): tl.RawDialogFilter {
  return {
    _: "dialogFilter",
    id: 0,
    title: {
      _: "textWithEntities",
      text: title,
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
    includePeers: peers,
    excludePeers: [],
  };
}

export async function readUnfiledDialogs(path: string): Promise<UnfiledDialogsPayload> {
  const rawText = await readFile(path, "utf8");
  const payload = JSON.parse(rawText) as UnfiledDialogsPayload;
  if (!Array.isArray(payload.results)) {
    throw new Error(`未分类对话文件格式无效: ${path}`);
  }

  return payload;
}

export async function addUnfiledDialogsToFolder(
  client: TelegramClient,
  dialogs: CollectedDialog[],
  payload: UnfiledDialogsPayload,
  folderTitle: string,
  dryRun: boolean,
): Promise<void> {
  const normalizedTitle = folderTitle.trim();
  if (!normalizedTitle) {
    throw new Error("文件夹名称不能为空。");
  }

  const dialogById = new Map(dialogs.map((item) => [item.info.id, item]));
  const candidates = dedupeInputPeers(
    payload.results
      .map((record) => dialogById.get(record.id)?.info.inputPeer)
      .filter((peer): peer is tl.TypeInputPeer => Boolean(peer)),
  );
  const missingCount = payload.results.length - candidates.length;

  if (candidates.length === 0) {
    console.log(`没有可加入文件夹 ${normalizedTitle} 的未分类会话。`);
    if (missingCount > 0) {
      console.log(`跳过 ${missingCount} 个当前 Telegram 对话列表中找不到的记录。`);
    }
    return;
  }

  const folders = (await client.getFolders()).filters;
  const sameTitleFolder = folders.filter(isCustomFolder).find((folder) => titleText(folder) === normalizedTitle);
  if (sameTitleFolder && !isEditableFolder(sameTitleFolder)) {
    throw new Error(`已存在名称为“${normalizedTitle}”的不可编辑文件夹，无法追加会话。`);
  }

  const existingFolder = sameTitleFolder && isEditableFolder(sameTitleFolder) ? sameTitleFolder : null;
  if (!existingFolder) {
    if (dryRun) {
      console.log(`[dry-run] 将创建文件夹 ${normalizedTitle}: ${candidates.length} 个会话`);
    } else {
      await client.createFolder(buildFolderPayload(normalizedTitle, candidates));
      console.log(`已创建文件夹 ${normalizedTitle}: 新增 ${candidates.length} 个会话`);
    }
    if (missingCount > 0) {
      console.log(`跳过 ${missingCount} 个当前 Telegram 对话列表中找不到的记录。`);
    }
    return;
  }

  const mergedPeers = dedupeInputPeers([...existingFolder.includePeers, ...candidates]);
  const addedCount = mergedPeers.length - existingFolder.includePeers.length;
  if (addedCount <= 0) {
    console.log(`文件夹 ${normalizedTitle} 无需新增会话。`);
    if (missingCount > 0) {
      console.log(`跳过 ${missingCount} 个当前 Telegram 对话列表中找不到的记录。`);
    }
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] 将向文件夹 ${normalizedTitle} 新增 ${addedCount} 个会话，更新后共 ${mergedPeers.length} 个会话`);
  } else {
    await client.editFolder({
      folder: existingFolder,
      modification: {
        includePeers: mergedPeers,
      },
    });
    console.log(`已向文件夹 ${normalizedTitle} 新增 ${addedCount} 个会话，更新后共 ${mergedPeers.length} 个会话`);
  }

  if (missingCount > 0) {
    console.log(`跳过 ${missingCount} 个当前 Telegram 对话列表中找不到的记录。`);
  }
}
