import { Dialog, type tl } from "@mtcute/node";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";

function folderPinnedPeerKeys(folder: tl.RawDialogFilter | tl.RawDialogFilterChatlist): Set<string> {
  return new Set(folder.pinnedPeers.map((peer) => inputPeerKey(peer)));
}

export function collectDialogPeerKeysInCustomFolder(
  dialogs: CollectedDialog[],
  folder: tl.RawDialogFilter | tl.RawDialogFilterChatlist,
): Set<string> {
  const peerKeys = new Set<string>();
  const pinnedPeerKeys = folderPinnedPeerKeys(folder);
  const matchesFolder = Dialog.filterFolder(folder, false);

  for (const item of dialogs) {
    const peerKey = inputPeerKey(item.info.inputPeer);
    if (pinnedPeerKeys.has(peerKey) || matchesFolder(item.dialog)) {
      peerKeys.add(peerKey);
    }
  }

  return peerKeys;
}
