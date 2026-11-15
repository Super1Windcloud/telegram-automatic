import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Message, TelegramClient } from "@mtcute/node";
import { loadConfig } from "./config.js";
import { loadEnvironment } from "./env.js";
import { collectDialogsWithState, createTelegramClient, startTelegramClient, type CollectedDialog } from "./telegram.js";
import { iterPosts, readScanOptions, selectChannels, type ScanOptions } from "./weight-scan.js";

type ExportOptions = ScanOptions & { exportFile: string; downloadTimeoutMs: number };
type ImageReference = { messageId: number; fileId: string; mimeType: string; fileSize?: number; dcId?: number };
type Source = { channelId: number; channelTitle: string; messageIds: number[]; links: string[]; date: string };
type Content = { id: string; text: string; sources: Source[]; images: ImageReference[] };
type ExportImage = { messageId: number; mimeType: string; byteLength: number; sha256: string; base64: string };
type ScanError = { channelId: number; messageId?: number; error: string };

export function normalizedText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function readExportOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env): ExportOptions {
  if (argv.includes("--below")) throw new Error("scan 仅采集和去重，不进行体重筛选，请移除 --below。");
  const options = readScanOptions(argv, environment, false);
  const exportFile = resolve(options.output, environment.TELEGRAM_SCAN_EXPORT_FILE?.trim() || "folder-content.json");
  if (!exportFile.endsWith(".json")) throw new Error("TELEGRAM_SCAN_EXPORT_FILE 必须以 .json 结尾。");
  const downloadTimeoutMs = Number(environment.TELEGRAM_SCAN_DOWNLOAD_TIMEOUT_MS?.trim() || "60000");
  if (!Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs <= 0 || downloadTimeoutMs > 2_147_483_647) throw new Error("TELEGRAM_SCAN_DOWNLOAD_TIMEOUT_MS 必须是 1 到 2147483647 的整数。");
  return { ...options, exportFile, downloadTimeoutMs };
}

function isVideo(message: Message): boolean {
  const media = message.media;
  return media?.type === "video" || (media?.type === "document" && media.mimeType.startsWith("video/"));
}

function imageReference(message: Message): ImageReference | undefined {
  const media = message.media;
  if (media?.type !== "photo" && !(media?.type === "document" && media.mimeType.startsWith("image/"))) return;
  return { messageId: message.id, fileId: media.fileId, mimeType: media.type === "photo" ? "image/jpeg" : media.mimeType, fileSize: media.fileSize, dcId: media.dcId };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function readImage(client: TelegramClient, image: ImageReference, byteLimit: number, timeoutMs: number): Promise<ExportImage> {
  if (image.fileSize !== undefined && image.fileSize > byteLimit) throw new Error("图片超过配置的大小限制。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of client.downloadAsIterable(image.fileId, { fileSize: image.fileSize, dcId: image.dcId, abortSignal: AbortSignal.timeout(timeoutMs) })) {
    size += chunk.byteLength;
    if (size > byteLimit) throw new Error("图片超过配置的大小限制。");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks, size);
  return { messageId: image.messageId, mimeType: image.mimeType, byteLength: size,
    sha256: createHash("sha256").update(buffer).digest("hex"), base64: buffer.toString("base64") };
}

export async function exportFolderContents(client: TelegramClient, channels: CollectedDialog[], options: ExportOptions): Promise<void> {
  await mkdir(dirname(options.exportFile), { recursive: true });
  const lockPath = `${options.exportFile}.lock`;
  const lock = await open(lockPath, "wx").catch(() => { throw new Error(`输出文件已锁定或无法写入：${lockPath}`); });
  const startedAt = new Date().toISOString();
  const stats = { channels: channels.length, channelsCompleted: 0, messagesRead: 0, postsRead: 0,
    videosSkipped: 0, unsupportedMessagesSkipped: 0, uniquePosts: 0, duplicatesRemoved: 0, imagesExported: 0 };
  const records = new Map<string, Content>();
  const errors: ScanError[] = [];
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt }));
    // Finish text deduplication across all channels before downloading retained images.
    for (const channel of channels) {
      try {
        for await (const post of iterPosts(client.iterHistory(channel.info.inputPeer), options)) {
          stats.messagesRead += post.length;
          stats.postsRead += 1;
          const messages = post.filter((message) => { if (isVideo(message)) { stats.videosSkipped += 1; return false; } return true; })
            .sort((a, b) => a.id - b.id);
          const text = [...new Set(messages.map((message) => message.text.trim()).filter(Boolean))].join("\n");
          const images = messages.flatMap((message) => { const image = imageReference(message); return image ? [image] : []; });
          if (!text && !images.length) { stats.unsupportedMessagesSkipped += messages.length; continue; }
          const source: Source = { channelId: channel.info.id, channelTitle: channel.info.title,
            messageIds: messages.map((message) => message.id), links: messages.map((message) => message.link), date: messages[0].date.toISOString() };
          const normalized = normalizedText(text);
          // Empty captions cannot identify duplicate pictures, so keep each such album.
          const id = createHash("sha256").update(normalized ? `text:${normalized}` : `source:${source.channelId}:${source.messageIds.join(",")}`).digest("hex");
          const existing = records.get(id);
          if (existing) { existing.sources.push(source); stats.duplicatesRemoved += 1; }
          else { records.set(id, { id, text, sources: [source], images }); stats.uniquePosts += 1; }
          if (stats.postsRead % 1000 === 0) console.log(`[采集] 已读 ${stats.messagesRead} 条消息，去重后 ${stats.uniquePosts} 条内容。`);
        }
        stats.channelsCompleted += 1;
      } catch (error) {
        errors.push({ channelId: channel.info.id, error: errorText(error) });
        console.error(`[频道失败] ${channel.info.title}：${errorText(error)}`);
      }
      console.log(`[采集] ${channel.info.title}；累计 ${stats.messagesRead} 条消息，去重后 ${stats.uniquePosts} 条，重复 ${stats.duplicatesRemoved} 条。`);
    }
    const temporary = `${options.exportFile}.${process.pid}.tmp`;
    const file = await open(temporary, "w");
    try {
      const header = { schemaVersion: 1, stage: "collected", nextStep: "awaiting_user", folder: options.folder, startedAt,
        range: { limitPerChannel: options.limit, since: options.since?.toISOString() ?? null },
        deduplication: { method: "normalized_text", normalization: "NFKC and collapsed whitespace", imagesCompared: false, emptyText: "keep_each_post", retainedImages: "first_occurrence" } };
      await file.writeFile(`${JSON.stringify(header, null, 2).slice(0, -2)},\n  "records": [`);
      let written = 0;
      for (const record of records.values()) {
        const images: ExportImage[] = [];
        const imageErrors: Array<{ messageId: number; error: string }> = [];
        let bytes = 0;
        for (const image of record.images) {
          try {
            const exported = await readImage(client, image, Math.min(options.maxImageBytes, options.maxAlbumBytes - bytes), options.downloadTimeoutMs);
            bytes += exported.byteLength;
            images.push(exported);
            stats.imagesExported += 1;
          } catch (error) {
            const row = { messageId: image.messageId, error: errorText(error) };
            imageErrors.push(row);
            errors.push({ channelId: record.sources[0].channelId, ...row });
          }
        }
        const row = { id: record.id, text: record.text, sources: record.sources, images, imageErrors };
        await file.writeFile(`${written ? "," : ""}\n${JSON.stringify(row, null, 2).split("\n").map((line) => `    ${line}`).join("\n")}`);
        written += 1;
        if (written % 50 === 0 || written === records.size) console.log(`[导出] ${written}/${records.size} 条内容，${stats.imagesExported} 张图片。`);
      }
      const tail = { complete: errors.length === 0, finishedAt: new Date().toISOString(), stats, errors };
      await file.writeFile(`\n  ],\n${JSON.stringify(tail, null, 2).slice(2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, options.exportFile);
  } finally { await lock.close(); await unlink(lockPath); }
  console.log(`已输出：${options.exportFile}；去重后 ${stats.uniquePosts} 条，重复 ${stats.duplicatesRemoved} 条，图片 ${stats.imagesExported} 张，错误 ${errors.length}。`);
  if (errors.length) throw new Error("采集或图片下载有失败，已保留 JSON 部分结果（complete=false）；未执行后续分析。");
  console.log("采集完成，等待用户指定下一步；未执行 OCR、摘要或体重筛选。");
}

export async function scanFolderContents(argv: string[]): Promise<void> {
  loadEnvironment();
  const options = readExportOptions(argv);
  if (options.help) {
    console.log("npm run scan -- [--folder <名称>] [--limit <条数>] [--since <ISO日期>] [--output <目录>] [--dry-run]\n读取文件夹频道，按文字内容跨频道去重，跳过视频，图片编码为 Base64，输出格式化 JSON 后停止。\n输出文件由 TELEGRAM_SCAN_EXPORT_FILE 配置。不需要模型 API，不自动执行 OCR、摘要或筛选。");
    return;
  }
  const config = await loadConfig();
  const client = createTelegramClient(config);
  try {
    await startTelegramClient(client, config);
    const channels = selectChannels(await collectDialogsWithState(client), (await client.getFolders()).filters, options.folder);
    console.log(`文件夹“${options.folder}”：${channels.length} 个频道；每频道 ${options.limit || "全部"} 条消息；仅采集，文字去重。`);
    for (const channel of channels) console.log(`  ${channel.info.title} (${channel.info.id})`);
    if (options.dryRun) return;
    if (!channels.length) throw new Error("文件夹中没有可访问的频道。");
    await exportFolderContents(client, channels, options);
  } finally { await client.destroy(); }
}
