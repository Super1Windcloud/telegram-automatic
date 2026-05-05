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

function isEditableFolder(filter: tl.TypeDialogFilter): filter is tl.RawDialogFilter {
  return filter._ === "dialogFilter";
}

export async function collectUnfiledDialogs(
  client: TelegramClient,
  dialogs: DialogInfo[],
): Promise<UnfiledDialogsPayload> {
  const response = await client.getFolders();
  const folders = response.filters.filter(isEditableFolder);
  const includedPeers = new Set<string>();

  for (const folder of folders) {
    for (const peer of folder.includePeers) {
      if (peer._ === "inputPeerEmpty") {
        continue;
      }
      includedPeers.add(inputPeerKey(peer));
    }
  }

  const results = dialogs
    .filter((dialog) => !includedPeers.has(inputPeerKey(dialog.inputPeer)))
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
