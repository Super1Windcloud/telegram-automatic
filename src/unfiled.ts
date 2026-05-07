import { writeFile } from "node:fs/promises";
import type { tl } from "@mtcute/node";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import type { UnfiledDialogsPayload } from "./types.js";

const EXCLUDED_TITLES = new Set(["demo", "superwindcloud"]);

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }
  return "";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
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

export function collectUnfiledDialogs(
  dialogs: CollectedDialog[],
  folders: tl.TypeDialogFilter[],
): UnfiledDialogsPayload {
  const activeDialogs = dialogs.filter((item) => !item.dialog.isArchived);
  const customFolders = folders.filter(isCustomFolder);
  const filedPeerKeys = collectFiledPeerKeys(activeDialogs, customFolders);

  const results = activeDialogs
    .filter((item) => !EXCLUDED_TITLES.has(item.info.title))
    .filter((item) => !filedPeerKeys.has(inputPeerKey(item.info.inputPeer)))
    .map(({ info: { inputPeer: _inputPeer, ...dialog } }) => dialog);

  return {
    totalDialogs: activeDialogs.length,
    customFolderCount: customFolders.length,
    customFolderTitles: customFolders.map((folder) => titleText(folder) || `id=${folder.id}`),
    unfiledCount: results.length,
    results,
  };
}

export async function writeUnfiledDialogs(path: string, payload: UnfiledDialogsPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
