import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { TelegramClient } from "@mtcute/node";
import { loadConfig } from "./config.js";
import { loadEnvironment } from "./env.js";
import { collectDialogsWithState, createTelegramClient, startTelegramClient, type CollectedDialog } from "./telegram.js";
import { selectChannels } from "./weight-scan.js";

export function readMessageStatsOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  let folder = environment.TELEGRAM_SCAN_FOLDER?.trim() ?? "";
  let output = environment.TELEGRAM_MESSAGE_STATS_OUTPUT?.trim()
    || resolve(environment.TELEGRAM_SCAN_OUTPUT?.trim() || "weight-scan", "message-stats.json");
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help") { help = true; continue; }
    if (arg !== "--folder" && arg !== "--output") throw new Error(`未知消息统计参数: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少值。`);
    if (arg === "--folder") folder = value.trim();
    else output = value;
  }
  if (!help && !folder) throw new Error("缺少 TELEGRAM_SCAN_FOLDER，请填写 .env 或使用 --folder。");
  if (!/\.json$/i.test(output)) throw new Error("消息统计输出文件必须以 .json 结尾。");
  return { folder, output: resolve(output), help };
}

export type ChannelMessageStat = {
  channelId: number; channelTitle: string; username: string | null;
  messageCount: number | null; queriedAt: string; error?: string;
};

export async function collectMessageStats(
  client: Pick<TelegramClient, "getHistory">, channels: CollectedDialog[], folder: string,
) {
  const startedAt = new Date().toISOString();
  const results: ChannelMessageStat[] = [];
  let knownTotalMessages = 0;
  for (const channel of channels) {
    const row: ChannelMessageStat = { channelId: channel.info.id, channelTitle: channel.info.title,
      username: channel.info.username ?? null, messageCount: null, queriedAt: "" };
    try {
      // Use Telegram's history count, never the page size or the largest message ID.
      const history = await client.getHistory(channel.info.inputPeer, { limit: 1 });
      if (!Number.isSafeInteger(history.total) || history.total < 0) throw new Error("Telegram 返回了无效的历史消息总数。");
      row.messageCount = history.total;
      knownTotalMessages += history.total;
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    }
    row.queriedAt = new Date().toISOString();
    results.push(row);
  }
  const successfulChannels = results.filter((row) => row.messageCount !== null).length;
  const complete = successfulChannels === channels.length;
  return { folder, startedAt, finishedAt: new Date().toISOString(), complete,
    countMethod: "telegram_history_total", scope: "all_accessible_channel_history", deduplicated: false,
    includesVideos: true, albumUnit: "individual_message", channelCount: channels.length,
    successfulChannels, failedChannels: channels.length - successfulChannels,
    totalMessages: complete ? knownTotalMessages : null, knownTotalMessages, results };
}

export async function exportMessageStats(argv: string[]): Promise<void> {
  loadEnvironment();
  const options = readMessageStatsOptions(argv);
  if (options.help) {
    console.log("npm run message-stats -- [--folder <文件夹名称>] [--output <JSON文件>]\n默认读取 TELEGRAM_SCAN_FOLDER，输出到 TELEGRAM_MESSAGE_STATS_OUTPUT 或扫描目录下的 message-stats.json。\n统计各频道的全部可访问历史消息和合计，包含视频、重复消息，相册按单条消息计数，不受扫描 limit/since 影响。不下载媒体、不调用模型。");
    return;
  }
  const config = await loadConfig();
  const client = createTelegramClient(config);
  try {
    await startTelegramClient(client, config);
    const channels = selectChannels(await collectDialogsWithState(client), (await client.getFolders()).filters, options.folder);
    const report = await collectMessageStats(client, channels, options.folder);
    await mkdir(dirname(options.output), { recursive: true });
    const temporary = `${options.output}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, options.output);
    console.table(report.results.map((row) => ({ 频道: row.channelTitle, ID: row.channelId,
      消息数: row.messageCount ?? "查询失败", 错误: row.error ?? "" })));
    console.log(`文件夹“${report.folder}”：${report.channelCount} 个频道；${report.complete ? `总计 ${report.totalMessages} 条消息` : `统计不完整，已确认 ${report.knownTotalMessages} 条消息`}。\n输出：${options.output}`);
    if (!report.complete) throw new Error("部分频道统计失败，已保存不完整报告（失败频道的消息数为 null）；请检查报告后重跑。");
  } finally { await client.destroy(); }
}
