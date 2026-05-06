import { writeFile } from "node:fs/promises";
import type { TelegramClient, tl } from "@mtcute/node";
import { inputPeerKey } from "./telegram.js";
import type { DialogInfo, UnfiledDialogsPayload } from "./types.js";

function titleText(filter: tl.TypeDialogFilter): string {
  if ("title" in filter && filter.title && typeof filter.title === "object" && "text" in filter.title) {
    return filter.title.text;
  }
  return "";
}

function isCustomFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist {
  return filter._ === "dialogFilter" || filter._ === "dialogFilterChatlist";
}

async function collectFiledPeerKeys(
  client: TelegramClient,
  folders: Array<tl.RawDialogFilter | tl.RawDialogFilterChatlist>,
): Promise<Set<string>> {
  const filedPeerKeys = new Set<string>();

  for (const folder of folders) {
    for await (const dialog of client.iterDialogs({
      folder: folder as unknown as tl.RawDialogFilter,
      pinned: "keep",
      archived: "keep",
    })) {
      const peer = dialog.peer.inputPeer;
      if (peer._ === "inputPeerEmpty") {
        continue;
      }
      filedPeerKeys.add(inputPeerKey(peer));
    }
  }

  return filedPeerKeys;
}

export async function collectUnfiledDialogs(
  client: TelegramClient,
  dialogs: DialogInfo[],
): Promise<UnfiledDialogsPayload> {
  const response = await client.getFolders();
  const folders = response.filters.filter(isCustomFolder);
  const filedPeerKeys = await collectFiledPeerKeys(client, folders);

  const results = dialogs
    .filter((dialog) => !filedPeerKeys.has(inputPeerKey(dialog.inputPeer)))
    .map(({ inputPeer: _inputPeer, ...dialog }) => dialog);

  return {
    totalDialogs: dialogs.length,
    customFolderCount: folders.length,
    customFolderTitles: folders.map((folder) => titleText(folder) || `id=${folder.id}`),
    unfiledCount: results.length,
    results,
  };
}

export async function writeUnfiledDialogs(path: string, payload: UnfiledDialogsPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
