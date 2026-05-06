import { writeFile } from "node:fs/promises";
import type { tl } from "@mtcute/node";
import { type CollectedDialog } from "./telegram.js";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import type { FolderStat, FolderStatsPayload } from "./types.js";

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }
  return "";
}

function folderDisplayTitle(filter: tl.TypeDialogFilter): string {
  const title = titleText(filter);
  if (title) {
    return title;
  }
  if (filter._ === "dialogFilterDefault") {
    return "All";
  }
  return filter._;
}

function folderId(filter: tl.TypeDialogFilter): number | null {
  return "id" in filter && typeof filter.id === "number" ? filter.id : null;
}

function folderFlags(filter: tl.TypeDialogFilter): FolderStat["flags"] {
  if (filter._ !== "dialogFilter") {
    return {
      contacts: null,
      nonContacts: null,
      groups: null,
      broadcasts: null,
      bots: null,
      excludeMuted: null,
      excludeRead: null,
      excludeArchived: null,
    };
  }

  return {
    contacts: filter.contacts ?? null,
    nonContacts: filter.nonContacts ?? null,
    groups: filter.groups ?? null,
    broadcasts: filter.broadcasts ?? null,
    bots: filter.bots ?? null,
    excludeMuted: filter.excludeMuted ?? null,
    excludeRead: filter.excludeRead ?? null,
    excludeArchived: filter.excludeArchived ?? null,
  };
}

function peerListCount(filter: tl.TypeDialogFilter, field: "includePeers" | "pinnedPeers" | "excludePeers"): number {
  if (filter._ === "dialogFilter") {
    const peers = filter[field];
    return Array.isArray(peers) ? peers.length : 0;
  }

  if (filter._ === "dialogFilterChatlist") {
    if (field === "excludePeers") {
      return 0;
    }

    const peers = filter[field];
    return Array.isArray(peers) ? peers.length : 0;
  }

  return 0;
}

export function collectFolderStats(dialogs: CollectedDialog[], folders: tl.TypeDialogFilter[]): FolderStatsPayload {
  const results: FolderStat[] = [];
  const customFolderPeerKeys = new Set<string>();

  for (const folder of folders) {
    const dialogPeerKeys = folder._ === "dialogFilter" || folder._ === "dialogFilterChatlist"
      ? collectDialogPeerKeysInCustomFolder(dialogs, folder)
      : new Set<string>();
    results.push({
      type: folder._,
      id: folderId(folder),
      title: folderDisplayTitle(folder),
      dialogCount: dialogPeerKeys.size,
      includedPeerCount: peerListCount(folder, "includePeers"),
      pinnedPeerCount: peerListCount(folder, "pinnedPeers"),
      excludePeerCount: peerListCount(folder, "excludePeers"),
      flags: folderFlags(folder),
    });

    if (folder._ === "dialogFilter" || folder._ === "dialogFilterChatlist") {
      for (const peerKey of dialogPeerKeys) {
        customFolderPeerKeys.add(peerKey);
      }
      continue;
    }

    if (folder._ === "dialogFilterDefault") {
      results[results.length - 1].dialogCount = dialogs.length;
    }
  }

  const totalDialogs = results.find((item) => item.type === "dialogFilterDefault")?.dialogCount ?? 0;

  return {
    totalFolders: folders.length,
    totalDialogs,
    customFolderFiledDialogsUniqueCount: customFolderPeerKeys.size,
    unfiledDialogsCount: Math.max(totalDialogs - customFolderPeerKeys.size, 0),
    results,
  };
}

export async function writeFolderStats(path: string, payload: FolderStatsPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
