import { classificationExists, classifySnapshot, readClassification, writeClassification } from "./src/classifier.js";
import { getClassifiedPath, getFolderStatsPath, getSnapshotPath, getUnfiledPath, loadConfig, resolveConfigPath } from "./src/config.js";
import { collectFolderStats, writeFolderStats } from "./src/folder-stats.js";
import { applyClassifiedFolders } from "./src/folders.js";
import { readSnapshot, writeSnapshot } from "./src/snapshot.js";
import { collectDialogs, collectDialogsWithState, createTelegramClient, startTelegramClient } from "./src/telegram.js";
import { collectUnfiledDialogs, writeUnfiledDialogs } from "./src/unfiled.js";

async function exportSnapshot(): Promise<void> {
  const config = await loadConfig();
  const snapshotPath = getSnapshotPath();
  const client = createTelegramClient(config);

  try {
    await startTelegramClient(client, config);
    const dialogs = await collectDialogs(client);
    await writeSnapshot(snapshotPath, dialogs);
    console.log(`已导出 ${dialogs.length} 个会话到: ${snapshotPath}`);
  } finally {
    await client.destroy();
  }
}

async function classifySnapshotFile(skipIfExists = false): Promise<void> {
  const config = await loadConfig();
  const snapshotPath = getSnapshotPath();
  const classifiedPath = getClassifiedPath();

  if (skipIfExists && await classificationExists(classifiedPath)) {
    console.log(`检测到已有分类结果，跳过分类请求: ${classifiedPath}`);
    return;
  }

  const dialogs = await readSnapshot(snapshotPath);
  console.log("request:");
  console.log(`  config_path: ${await resolveConfigPath()}`);
  console.log(`  snapshot_path: ${snapshotPath}`);
  console.log(`  classified_path: ${classifiedPath}`);
  console.log(`  dialogs: ${dialogs.length}`);
  console.log(`  model: ${config.openai.model}`);
  console.log(`  api_style: ${config.openai.apiStyle}`);
  console.log(`  base_url: ${config.openai.baseUrl}`);
  console.log(`  batch_size: ${config.openai.batchSize}`);
  console.log(`  max_retries: ${config.openai.maxRetries}`);
  console.log(`  retry_delay_seconds: ${config.openai.retryDelaySeconds}`);

  const payload = await classifySnapshot(dialogs, config);
  await writeClassification(classifiedPath, payload);
  console.log(`已输出分类结果到: ${classifiedPath}`);
  console.log(`model: ${payload.model}`);
  console.log(`api_style: ${payload.apiStyle}`);
  console.log(`total: ${payload.total}`);
  console.log(`group_count: ${Object.keys(payload.groups).length}`);
}

async function applyFolders(): Promise<void> {
  const config = await loadConfig();
  const classifiedPath = getClassifiedPath();
  const client = createTelegramClient(config);

  try {
    await startTelegramClient(client, config);
    const dialogs = await collectDialogs(client);
    const payload = await readClassification(classifiedPath);
    await applyClassifiedFolders(client, dialogs, payload, config.dryRun);
  } finally {
    await client.destroy();
  }
}

async function exportUnfiledDialogs(): Promise<void> {
  const config = await loadConfig();
  const outputPath = getUnfiledPath();
  const client = createTelegramClient(config);

  try {
    await startTelegramClient(client, config);
    const folders = (await client.getFolders()).filters;
    const dialogs = await collectDialogsWithState(client);
    const payload = collectUnfiledDialogs(dialogs, folders);
    await writeUnfiledDialogs(outputPath, payload);
    console.log(`已输出 ${payload.unfiledCount} 个未归属任何自定义文件夹的会话到: ${outputPath}`);
    console.log(`total_dialogs: ${payload.totalDialogs}`);
    console.log(`custom_folder_count: ${payload.customFolderCount}`);
  } finally {
    await client.destroy();
  }
}

async function exportFolderStats(): Promise<void> {
  const config = await loadConfig();
  const outputPath = getFolderStatsPath();
  const client = createTelegramClient(config);

  try {
    await startTelegramClient(client, config);
    const folders = (await client.getFolders()).filters;
    const dialogs = await collectDialogsWithState(client);
    const payload = collectFolderStats(dialogs, folders);
    await writeFolderStats(outputPath, payload);
    console.log(`已输出 ${payload.totalFolders} 个文件夹的统计信息到: ${outputPath}`);
    console.log(`total_folders: ${payload.totalFolders}`);
    console.log(`total_dialogs: ${payload.totalDialogs}`);
  } finally {
    await client.destroy();
  }
}

async function runWorkflow(): Promise<void> {
  await exportSnapshot();
  await classifySnapshotFile(true);
  await applyFolders();
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";

  switch (command) {
    case "snapshot":
      await exportSnapshot();
      return;
    case "classify":
      await classifySnapshotFile();
      return;
    case "folders":
      await applyFolders();
      return;
    case "unfiled":
      await exportUnfiledDialogs();
      return;
    case "folder-stats":
      await exportFolderStats();
      return;
    case "run":
      await runWorkflow();
      return;
    default:
      throw new Error(`不支持的命令: ${command}。可用命令: snapshot, classify, folders, unfiled, folder-stats, run`);
  }
}

main().catch((error) => {
  console.error("执行失败:", error);
  process.exitCode = 1;
});
