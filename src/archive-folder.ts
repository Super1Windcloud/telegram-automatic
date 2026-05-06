import { Dialog, type TelegramClient, type tl } from "@mtcute/node";
import { dedupeInputPeers, inputPeerKey, type CollectedDialog } from "./telegram.js";

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }

  return "";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
}

function collectFolderPeers(
  dialogs: CollectedDialog[],
  folder: tl.RawDialogFilter | tl.RawDialogFilterChatlist,
): tl.TypeInputPeer[] {
  const pinnedPeerKeys = new Set(folder.pinnedPeers.map((peer) => inputPeerKey(peer)));
  const matchesFolder = Dialog.filterFolder(folder, false);
  const peers: tl.TypeInputPeer[] = [];

  for (const item of dialogs) {
    const peerKey = inputPeerKey(item.info.inputPeer);
    if (pinnedPeerKeys.has(peerKey) || matchesFolder(item.dialog)) {
      peers.push(item.info.inputPeer);
    }
  }

  return dedupeInputPeers(peers);
}

export async function archiveFolderByTitle(
  client: TelegramClient,
  dialogs: CollectedDialog[],
  folderTitle: string,
  dryRun: boolean,
): Promise<void> {
  const normalizedTitle = folderTitle.trim();
  if (!normalizedTitle) {
    throw new Error("文件夹名称不能为空。");
  }

  const folders = (await client.getFolders()).filters;
  const folder = folders.filter(isCustomFolder).find((item) => titleText(item) === normalizedTitle);

  if (!folder) {
    throw new Error(`未找到名称为“${normalizedTitle}”的自定义文件夹。`);
  }

  const peers = collectFolderPeers(dialogs, folder);
  if (peers.length === 0) {
    console.log(`文件夹 ${normalizedTitle} 中没有可归档的会话。`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] 将归档文件夹 ${normalizedTitle} 中的 ${peers.length} 个会话。`);
    return;
  }

  await client.archiveChats(peers);
  console.log(`已归档文件夹 ${normalizedTitle} 中的 ${peers.length} 个会话。`);
}
