import { writeFile } from "node:fs/promises";
import type { tl } from "@mtcute/node";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import type { FolderOverlapDialog, FolderOverlapsPayload } from "./types.js";

type CustomFolder = tl.RawDialogFilter | tl.RawDialogFilterChatlist;

type FolderRef = {
  id: number | null;
  title: string;
  type: string;
};

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }
  return "";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is CustomFolder {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
}

function folderId(filter: CustomFolder): number | null {
  return "id" in filter && typeof filter.id === "number" ? filter.id : null;
}

function folderRef(filter: CustomFolder): FolderRef {
  const id = folderId(filter);
  return {
    id,
    title: titleText(filter) || (id === null ? filter._ : `id=${id}`),
    type: filter._,
  };
}

export function collectFolderOverlaps(
  dialogs: CollectedDialog[],
  folders: tl.TypeDialogFilter[],
): FolderOverlapsPayload {
  const customFolders = folders.filter(isCustomFolder);
  const foldersByPeerKey = new Map<string, FolderRef[]>();

  for (const folder of customFolders) {
    const ref = folderRef(folder);
    for (const peerKey of collectDialogPeerKeysInCustomFolder(dialogs, folder)) {
      foldersByPeerKey.set(peerKey, [...(foldersByPeerKey.get(peerKey) ?? []), ref]);
    }
  }

  const results: FolderOverlapDialog[] = dialogs
    .map((item) => {
      const peerKey = inputPeerKey(item.info.inputPeer);
      const matchedFolders = foldersByPeerKey.get(peerKey) ?? [];
      if (matchedFolders.length < 2) {
        return null;
      }

      const { inputPeer: _inputPeer, ...dialog } = item.info;
      return {
        ...dialog,
        folderCount: matchedFolders.length,
        folders: matchedFolders.sort((left, right) => left.title.localeCompare(right.title, "zh-CN")),
      };
    })
    .filter((item): item is FolderOverlapDialog => item !== null)
    .sort((left, right) => {
      const countDiff = right.folderCount - left.folderCount;
      return countDiff !== 0 ? countDiff : left.title.localeCompare(right.title, "zh-CN");
    });

  return {
    totalDialogs: dialogs.length,
    customFolderCount: customFolders.length,
    overlappedDialogCount: results.length,
    results,
  };
}

export async function writeFolderOverlaps(path: string, payload: FolderOverlapsPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
