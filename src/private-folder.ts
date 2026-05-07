import type { TelegramClient, tl } from "@mtcute/node";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import { dedupeInputPeers, inputPeerKey, type CollectedDialog } from "./telegram.js";

const EXCLUDED_TITLES = new Set(["demo", "superwindcloud"]);
const PRIVATE_FOLDER_TITLE = "私聊";

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

function buildFolderPayload(peers: tl.TypeInputPeer[]): tl.RawDialogFilter {
  return {
    _: "dialogFilter",
    id: 0,
    title: {
      _: "textWithEntities",
      text: PRIVATE_FOLDER_TITLE,
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

function collectFiledPeerKeys(
  dialogs: CollectedDialog[],
  folders: Array<tl.RawDialogFilter | tl.RawDialogFilterChatlist>,
): Set<string> {
  const filedPeerKeys = new Set<string>();

  for (const folder of folders) {
    for (const peerKey of collectDialogPeerKeysInCustomFolder(dialogs, folder)) {
      filedPeerKeys.add(peerKey);
    }
  }

  return filedPeerKeys;
}

export async function syncPrivateDialogsToFolder(client: TelegramClient, dialogs: CollectedDialog[], dryRun: boolean): Promise<void> {
  const folders = (await client.getFolders()).filters;
  const customFolders = folders.filter(isCustomFolder);
  const activeDialogs = dialogs.filter((item) => !item.dialog.isArchived);
  const filedPeerKeys = collectFiledPeerKeys(activeDialogs, customFolders);

  const candidates = dedupeInputPeers(
    activeDialogs
      .filter((item) => item.info.entityKind === "user")
      .filter((item) => item.info.types.includes("private") && !item.info.types.includes("bot"))
      .filter((item) => !EXCLUDED_TITLES.has(item.info.title))
      .filter((item) => !filedPeerKeys.has(inputPeerKey(item.info.inputPeer)))
      .map((item) => item.info.inputPeer),
  );

  if (candidates.length === 0) {
    console.log(`没有需要加入文件夹 ${PRIVATE_FOLDER_TITLE} 的未分类个人用户会话。`);
    return;
  }

  const existingFolder = folders.filter(isEditableFolder).find((folder) => titleText(folder) === PRIVATE_FOLDER_TITLE);
  if (!existingFolder) {
    if (dryRun) {
      console.log(`[dry-run] 将创建文件夹 ${PRIVATE_FOLDER_TITLE}: ${candidates.length} 个会话`);
      return;
    }

    await client.createFolder(buildFolderPayload(candidates));
    console.log(`已创建文件夹 ${PRIVATE_FOLDER_TITLE}: 新增 ${candidates.length} 个会话`);
    return;
  }

  const mergedPeers = dedupeInputPeers([...existingFolder.includePeers, ...candidates]);
  const addedCount = mergedPeers.length - existingFolder.includePeers.length;
  if (addedCount <= 0) {
    console.log(`文件夹 ${PRIVATE_FOLDER_TITLE} 无需新增会话。`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] 将向文件夹 ${PRIVATE_FOLDER_TITLE} 新增 ${addedCount} 个会话，更新后共 ${mergedPeers.length} 个会话`);
    return;
  }

  await client.editFolder({
    folder: existingFolder,
    modification: {
      includePeers: mergedPeers,
    },
  });
  console.log(`已向文件夹 ${PRIVATE_FOLDER_TITLE} 新增 ${addedCount} 个会话，更新后共 ${mergedPeers.length} 个会话`);
}
