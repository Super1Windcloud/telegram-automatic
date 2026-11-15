import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Message, TelegramClient, tl } from "@mtcute/node";
import { loadConfig } from "./config.js";
import { collectDialogPeerKeysInCustomFolder } from "./folder-match.js";
import { inputPeerKey, type CollectedDialog } from "./telegram.js";
import { ANALYSIS_PROMPT, analyzeContent, decideWeight, parseAnalysis, type Analysis, type ImageInput, type WeightDecision } from "./weight-analysis.js";

export type ScanOptions = {
  folder: string; limit: number; below: number; since?: Date; output: string; dryRun: boolean; help: boolean;
  maxImageBytes: number; maxAlbumBytes: number; requestTimeoutMs: number;
};

function positiveNumber(value: string, name: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error(`${name} 必须是正数。`);
  return Number(value);
}

export function readScanOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env, requireWeight = true): ScanOptions {
  const values = {
    folder: environment.TELEGRAM_SCAN_FOLDER?.trim() ?? "",
    limit: environment.TELEGRAM_SCAN_LIMIT?.trim() || "0",
    below: environment.TELEGRAM_SCAN_BELOW_JIN?.trim() ?? "",
    since: environment.TELEGRAM_SCAN_SINCE?.trim() ?? "",
    output: environment.TELEGRAM_SCAN_OUTPUT?.trim() || "weight-scan",
    dryRun: environment.TELEGRAM_SCAN_DRY_RUN?.trim() || "false",
  };
  const help = argv.includes("--help");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--" || arg === "--help") continue;
    if (arg === "--dry-run" || arg === "--dry-run=true") { values.dryRun = "true"; continue; }
    if (arg === "--no-dry-run" || arg === "--dry-run=false") { values.dryRun = "false"; continue; }
    if (!["--folder", "--limit", "--below", "--since", "--output"].includes(arg)) throw new Error(`未知扫描参数: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少值。`);
    switch (arg) {
      case "--folder": values.folder = value.trim(); break;
      case "--limit": values.limit = value; break;
      case "--below": values.below = value; break;
      case "--since": values.since = value; break;
      case "--output": values.output = value; break;
    }
  }
  // Help must remain available before .env has been configured.
  if (help) return { folder: "", below: 0, limit: 0, output: resolve(values.output), dryRun: false, help: true,
    maxImageBytes: 0, maxAlbumBytes: 0, requestTimeoutMs: 0 };
  if (!values.folder) throw new Error("缺少 TELEGRAM_SCAN_FOLDER，请填写 .env 或使用 --folder。");
  if (requireWeight && !values.below) throw new Error("缺少 TELEGRAM_SCAN_BELOW_JIN，请填写 .env 或使用 --below。");
  if (!/^\d+$/.test(values.limit) || !Number.isSafeInteger(Number(values.limit))) throw new Error("TELEGRAM_SCAN_LIMIT / --limit 必须是非负整数，0 表示全部历史。");
  if (!["true", "false"].includes(values.dryRun)) throw new Error("TELEGRAM_SCAN_DRY_RUN 必须是 true 或 false。");
  const options: ScanOptions = {
    folder: values.folder, limit: Number(values.limit), below: requireWeight ? positiveNumber(values.below, "TELEGRAM_SCAN_BELOW_JIN / --below") : 0,
    output: resolve(values.output), dryRun: values.dryRun === "true", help: false,
    maxImageBytes: positiveNumber(environment.TELEGRAM_SCAN_IMAGE_MAX_MIB?.trim() || "15", "TELEGRAM_SCAN_IMAGE_MAX_MIB") * 1024 * 1024,
    maxAlbumBytes: positiveNumber(environment.TELEGRAM_SCAN_ALBUM_MAX_MIB?.trim() || "40", "TELEGRAM_SCAN_ALBUM_MAX_MIB") * 1024 * 1024,
    requestTimeoutMs: requireWeight ? positiveNumber(environment.TELEGRAM_SCAN_REQUEST_TIMEOUT_MS?.trim() || "120000", "TELEGRAM_SCAN_REQUEST_TIMEOUT_MS") : 0,
  };
  if (requireWeight && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs > 2_147_483_647)) throw new Error("TELEGRAM_SCAN_REQUEST_TIMEOUT_MS 必须是 1 到 2147483647 的整数。");
  if (!Number.isSafeInteger(options.maxImageBytes) || !Number.isSafeInteger(options.maxAlbumBytes)) throw new Error("图片大小配置换算后的字节数必须是安全整数。");
  if (values.since) {
    const value = values.since;
    // Dates use UTC; timestamps must include a timezone to avoid machine-dependent ranges.
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new Error("TELEGRAM_SCAN_SINCE / --since 需要有效 ISO 日期或含时区时间，例如 2026-11-01 或 2026-11-01T00:00:00+08:00。");
    }
    options.since = new Date(value);
  }
  return options;
}

export function selectChannels(dialogs: CollectedDialog[], folders: tl.TypeDialogFilter[], title: string): CollectedDialog[] {
  const matches = folders.filter((folder): folder is tl.RawDialogFilter | tl.RawDialogFilterChatlist =>
    (folder._ === "dialogFilter" || folder._ === "dialogFilterChatlist") && folder.title.text === title);
  if (matches.length !== 1) throw new Error(matches.length ? `存在多个同名文件夹“${title}”，请先重命名。` : `未找到文件夹“${title}”。`);
  const keys = collectDialogPeerKeysInCustomFolder(dialogs, matches[0]);
  return dialogs.filter((item) => item.info.entityKind === "channel" && keys.has(inputPeerKey(item.info.inputPeer)));
}

// Read one extra message at a boundary so a limit/date cutoff never splits an album.
export async function* iterPosts(messages: AsyncIterable<Message>, options: Pick<ScanOptions, "limit" | "since">): AsyncGenerator<Message[]> {
  let post: Message[] = [];
  let count = 0;
  for await (const message of messages) {
    const sameAlbum = post.length > 0 && message.groupedIdUnique !== null && message.groupedIdUnique === post[0].groupedIdUnique;
    if (post.length && !sameAlbum) { yield post; post = []; }
    if (!sameAlbum && ((options.limit > 0 && count >= options.limit) || (options.since && message.date < options.since))) break;
    count += 1;
    if (message.isService) continue;
    post.push(message);
  }
  if (post.length) yield post;
}

type ScanRecord = {
  channelId: number; channelTitle: string; messageIds: number[]; links: string[]; date: string;
  texts: Array<{ messageId: number; text: string }>; analysis?: Analysis; decision: WeightDecision;
  unsupportedMedia: string[]; error?: string;
};

async function collectImages(client: TelegramClient, post: Message[], options: ScanOptions): Promise<ImageInput[]> {
  const images: ImageInput[] = [];
  let totalBytes = 0;
  for (const message of post) {
    const media = message.media;
    if (!media || (media.type !== "photo" && !(media.type === "document" && media.mimeType.startsWith("image/")))) continue;
    const mime = media.type === "photo" ? "image/jpeg" : media.mimeType;
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error(`图片 ${message.id} 不支持 ${mime}，请人工核对。`);
    if (media.fileSize !== undefined && media.fileSize > options.maxImageBytes) throw new Error(`图片 ${message.id} 超过配置的单图大小限制。`);
    const bytes = await client.downloadAsBuffer(media);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > options.maxImageBytes || totalBytes > options.maxAlbumBytes) throw new Error("单图或相册超过配置的图片大小限制。");
    images.push({ messageId: message.id, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` });
  }
  return images;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function markdownRecord(record: ScanRecord): string {
  const quote = (value: string) => value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `\n## ${record.channelTitle.replace(/[\r\n]/g, " ")} / ${record.messageIds.join(", ")}\n\n`
    + `时间：${record.date}\n\n来源：${record.links.join(" ")}\n\n体重：${record.decision.weights.map((item) => `${item.jin} 斤`).join(" / ")}\n\n`
    + `摘要：\n${quote(record.analysis?.summary ?? "")}\n\n原文：\n${quote(record.texts.map((item) => `[${item.messageId}] ${item.text}`).join("\n"))}\n\n`
    + `OCR：\n${quote(record.analysis?.ocr.map((item) => `[${item.messageId}] ${item.text}`).join("\n") ?? "")}\n`;
}

export async function runScan(
  client: TelegramClient, channels: CollectedDialog[], api: Awaited<ReturnType<typeof loadConfig>>["openai"], options: ScanOptions,
): Promise<void> {
  await mkdir(options.output, { recursive: true });
  const lockPath = join(options.output, ".scan.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new Error(`无法锁定输出目录；检查是否有扫描正在运行或遗留 .scan.lock：${options.output}`); });
  const stats = { startedAt: new Date().toISOString(), finishedAt: "", complete: false,
    folder: options.folder, belowJin: options.below, limitPerChannel: options.limit, since: options.since?.toISOString(),
    channels: channels.length, channelsCompleted: 0, messages: 0, posts: 0, matched: 0, excluded: 0, review: 0, unknown: 0, cached: 0,
    errors: [] as Array<{ channelId: number; messageIds?: number[]; error: string }> };
  const output = (name: string) => join(options.output, name);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: stats.startedAt }));
    await mkdir(output("cache"), { recursive: true });
    for (const name of ["analysis.jsonl", "matches.jsonl", "review.jsonl"]) await writeFile(output(name), "", "utf8");
    await writeFile(output("matches.md"), `# ${options.folder}：体重低于 ${options.below} 斤的消息\n\n筛选依据为消息原文和图片 OCR；识别结果需要结合来源核对。\n`, "utf8");
    await atomicJson(output("summary.json"), stats);
    for (const channel of channels) {
      try {
        for await (const post of iterPosts(client.iterHistory(channel.info.inputPeer), options)) {
          post.sort((a, b) => a.id - b.id);
          stats.posts += 1;
          stats.messages += post.length;
          const texts = post.filter((message) => message.text.trim()).map((message) => ({ messageId: message.id, text: message.text }));
          const record: ScanRecord = { channelId: channel.info.id, channelTitle: channel.info.title,
            messageIds: post.map((message) => message.id), links: post.map((message) => message.link), date: post[0].date.toISOString(), texts,
            decision: { status: "unknown", weights: [], reason: "未分析" },
            unsupportedMedia: post.map((message) => message.media).filter((media) => media && media.type !== "photo"
              && !(media.type === "document" && media.mimeType.startsWith("image/"))).map((media) => media!.type) };
          const hash = createHash("sha256").update(JSON.stringify({ version: 1, prompt: ANALYSIS_PROMPT, channel: channel.info.id,
            messages: post.map((message) => ({ id: message.id, text: message.text,
              media: message.media?.type === "photo" || message.media?.type === "document" ? message.media.uniqueFileId : message.media?.type })),
            model: api.model, baseUrl: api.baseUrl, apiStyle: api.apiStyle })).digest("hex");
          const cachePath = output(`cache/${hash}.json`);
          const imageIds = post.filter((message) => message.media?.type === "photo" || (message.media?.type === "document" && message.media.mimeType.startsWith("image/"))).map((message) => message.id);
          try {
            const cached = await readFile(cachePath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
            if (cached !== null) {
              // Cached model output uses the same validation as a fresh response.
              record.analysis = parseAnalysis(cached, imageIds);
              stats.cached += 1;
            } else if (texts.length || imageIds.length) {
              record.analysis = await analyzeContent(api, texts, await collectImages(client, post, options), fetch, options.requestTimeoutMs);
              await atomicJson(cachePath, record.analysis);
            } else {
              record.analysis = { summary: "无文字或可识别静态图片，未分析视频、音频和其他媒体。", ocr: [] };
            }
            record.decision = decideWeight(texts, record.analysis.ocr, options.below);
          } catch (error) {
            record.error = errorMessage(error);
            record.decision = { status: "review", weights: [], reason: "下载、OCR 或摘要失败，不能视为已完成筛选。" };
            stats.errors.push({ channelId: channel.info.id, messageIds: record.messageIds, error: record.error });
          }
          stats[record.decision.status] += 1;
          const line = `${JSON.stringify(record)}\n`;
          await appendFile(output("analysis.jsonl"), line, "utf8");
          if (record.decision.status === "matched") {
            await appendFile(output("matches.jsonl"), line, "utf8");
            await appendFile(output("matches.md"), markdownRecord(record), "utf8");
          }
          if (record.decision.status === "review") await appendFile(output("review.jsonl"), line, "utf8");
          console.log(`[${channel.info.title}] ${post[0].id}: ${record.decision.status}${record.error ? ` (${record.error})` : ""}；已处理 ${stats.posts} 条内容，命中 ${stats.matched} 条。`);
          await atomicJson(output("summary.json"), stats);
        }
        stats.channelsCompleted += 1;
      } catch (error) {
        stats.errors.push({ channelId: channel.info.id, error: errorMessage(error) });
        console.error(`[频道失败] ${channel.info.title}: ${errorMessage(error)}`);
      }
    }
    stats.complete = stats.errors.length === 0;
  } finally {
    stats.finishedAt = new Date().toISOString();
    try { await atomicJson(output("summary.json"), stats); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  console.log(`输出：${options.output}；命中 ${stats.matched}，待核对 ${stats.review}，失败 ${stats.errors.length}。`);
  if (!stats.complete) throw new Error("扫描存在失败或未读完的频道；已保存部分结果。重跑相同命令会复用成功缓存并重试失败项。");
}

