import { readFile, writeFile } from "node:fs/promises";
import type { DialogInfo, DialogRecord } from "./types.js";

export async function writeSnapshot(path: string, dialogs: DialogInfo[]): Promise<void> {
  const payload: DialogRecord[] = dialogs.map(({ inputPeer: _inputPeer, ...dialog }) => dialog);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readSnapshot(path: string): Promise<DialogRecord[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("dialogs_snapshot.json 格式错误，预期为数组。");
  }

  return parsed as DialogRecord[];
}
