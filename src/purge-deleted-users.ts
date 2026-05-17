import { type TelegramClient } from "@mtcute/node";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";

function isDeletedUserDialog(item: CollectedDialog): boolean {
  return item.info.entityKind === "user" && item.info.isDeleted === true;
}

export async function purgeDeletedUserDialogs(
  client: TelegramClient,
  dialogs: CollectedDialog[],
  dryRun: boolean,
): Promise<void> {
  const targets = dialogs.filter(isDeletedUserDialog);

  if (targets.length === 0) {
    console.log("没有发现已注销用户的对话框。");
    return;
  }

  console.log(`发现 ${targets.length} 个已注销用户对话框。`);

  let deletedCount = 0;
  for (const item of targets) {
    const label = `${item.info.title} (${inputPeerKey(item.info.inputPeer)})`;
    if (dryRun) {
      console.log(`[dry-run] 将删除: ${label}`);
      continue;
    }

    await client.deleteHistory(item.info.inputPeer, { mode: "delete" });
    deletedCount += 1;
    console.log(`已删除: ${label}`);
  }

  if (dryRun) {
    console.log(`[dry-run] 共将删除 ${targets.length} 个已注销用户对话框。`);
    return;
  }

  console.log(`已删除 ${deletedCount} 个已注销用户对话框。`);
}
