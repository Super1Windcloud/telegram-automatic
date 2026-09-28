import type { TelegramClient, tl } from "@mtcute/node";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import { PRIVATE_FOLDER_TITLE } from "./private-folder.js";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }

  return "";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
}

function isEditableFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter {
  return filter._ === "dialogFilter";
}

function folderPeerKeys(
  dialogs: CollectedDialog[],
  folder: tl.RawDialogFilter | tl.RawDialogFilterChatlist,
): Set<string> {
  const keys = collectDialogPeerKeysInCustomFolder(dialogs, folder);
  for (const peer of [...folder.pinnedPeers, ...folder.includePeers]) {
    keys.add(inputPeerKey(peer));
  }
  return keys;
}

export async function clearPrivateFolderDialogs(
  client: TelegramClient,
  dialogs: CollectedDialog[],
  dryRun: boolean,
): Promise<void> {
  const folders = (await client.getFolders()).filters;
  const customFolders = folders.filter(isCustomFolder);
  const folder = customFolders.find((item) => titleText(item) === PRIVATE_FOLDER_TITLE);

  if (!folder) {
    throw new Error(`未找到名称为“${PRIVATE_FOLDER_TITLE}”的自定义文件夹。`);
  }

  const membership = new Map<string, string[]>();
  for (const item of customFolders) {
    const title = titleText(item);
    for (const peerKey of folderPeerKeys(dialogs, item)) {
      const titles = membership.get(peerKey) ?? [];
      if (!titles.includes(title)) {
        titles.push(title);
      }
      membership.set(peerKey, titles);
    }
  }

  const dialogByKey = new Map(dialogs.map((item) => [inputPeerKey(item.info.inputPeer), item]));
  const exclusive: CollectedDialog[] = [];
  const shared: Array<{ item: CollectedDialog; folders: string[] }> = [];

  for (const [peerKey, titles] of membership) {
    if (!titles.includes(PRIVATE_FOLDER_TITLE)) {
      continue;
    }

    const item = dialogByKey.get(peerKey);
    if (!item) {
      continue;
    }

    const otherFolders = titles.filter((title) => title !== PRIVATE_FOLDER_TITLE);
    if (otherFolders.length > 0) {
      shared.push({ item, folders: otherFolders });
      continue;
    }

    exclusive.push(item);
  }

  if (isEditableFolder(folder) && (folder.contacts || folder.nonContacts || folder.groups || folder.broadcasts || folder.bots)) {
    const enabled = [
      folder.contacts ? "联系人" : "",
      folder.nonContacts ? "非联系人" : "",
      folder.groups ? "群组" : "",
      folder.broadcasts ? "频道" : "",
      folder.bots ? "机器人" : "",
    ].filter(Boolean);
    console.log(`文件夹 ${PRIVATE_FOLDER_TITLE} 开启了类型筛选（${enabled.join("、")}），会覆盖其他文件夹里的同类会话。`);
  }

  if (shared.length > 0) {
    console.log(`跳过 ${shared.length} 个同时属于其他文件夹的对话。`);
    for (const { item, folders: otherFolders } of shared) {
      console.log(`跳过: ${item.info.title} (${inputPeerKey(item.info.inputPeer)})，同时属于 ${otherFolders.join("、")}`);
    }
  }

  if (exclusive.length === 0) {
    console.log(`文件夹 ${PRIVATE_FOLDER_TITLE} 中没有只属于该文件夹的对话。`);
    return;
  }

  console.log(`文件夹 ${PRIVATE_FOLDER_TITLE} 中有 ${exclusive.length} 个只属于该文件夹的对话。`);

  let deletedCount = 0;
  const deletedKeys = new Set<string>();
  for (const item of exclusive) {
    const key = inputPeerKey(item.info.inputPeer);
    const label = `${item.info.title} (${key})`;
    if (dryRun) {
      console.log(`[dry-run] 将删除对话: ${label}`);
      continue;
    }

    await client.deleteHistory(item.info.inputPeer, { mode: "delete" });
    deletedCount += 1;
    deletedKeys.add(key);
    console.log(`已删除对话: ${label}`);
  }

  if (dryRun) {
    console.log(`[dry-run] 将删除文件夹 ${PRIVATE_FOLDER_TITLE} 中 ${exclusive.length} 个只属于该文件夹的对话。`);
    return;
  }

  if (isEditableFolder(folder)) {
    const includePeers = folder.includePeers.filter((peer) => !deletedKeys.has(inputPeerKey(peer)));
    const pinnedPeers = folder.pinnedPeers.filter((peer) => !deletedKeys.has(inputPeerKey(peer)));
    if (includePeers.length !== folder.includePeers.length || pinnedPeers.length !== folder.pinnedPeers.length) {
      await client.editFolder({
        folder,
        modification: {
          includePeers,
          pinnedPeers,
        },
      });
    }
  }

  console.log(`已删除文件夹 ${PRIVATE_FOLDER_TITLE} 中 ${deletedCount} 个只属于该文件夹的对话。`);
}
