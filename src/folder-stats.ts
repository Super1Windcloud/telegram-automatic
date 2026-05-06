import { writeFile } from "node:fs/promises";
import type { TelegramClient, tl } from "@mtcute/node";
import { inputPeerKey } from "./telegram.js";
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

async function collectDialogPeerKeysInFolder(client: TelegramClient, folder: tl.TypeDialogFilter): Promise<Set<string>> {
  const peerKeys = new Set<string>();
  const params = folder._ === "dialogFilterDefault"
    ? { pinned: "keep" as const, archived: "keep" as const }
    : { folder: folder as tl.RawDialogFilter, pinned: "keep" as const, archived: "keep" as const };

  for await (const dialog of client.iterDialogs(params)) {
    const peer = dialog.peer.inputPeer;
    if (peer._ === "inputPeerEmpty") {
      continue;
    }
    peerKeys.add(inputPeerKey(peer));
  }

  return peerKeys;
}

export async function collectFolderStats(client: TelegramClient): Promise<FolderStatsPayload> {
  const response = await client.getFolders();
  const results: FolderStat[] = [];
  const customFolderPeerKeys = new Set<string>();

  for (const folder of response.filters) {
    const dialogPeerKeys = await collectDialogPeerKeysInFolder(client, folder);
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
    }
  }

  const totalDialogs = results.find((item) => item.type === "dialogFilterDefault")?.dialogCount ?? 0;

  return {
    totalFolders: results.length,
    totalDialogs,
    customFolderFiledDialogsUniqueCount: customFolderPeerKeys.size,
    unfiledDialogsCount: Math.max(totalDialogs - customFolderPeerKeys.size, 0),
    results,
  };
}

export async function writeFolderStats(path: string, payload: FolderStatsPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
