import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadEnvironment } from "./env.js";

function imageWidth(value: string | number): number {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("TELEGRAM_MARKDOWN_IMAGE_WIDTH / --image-width 必须是正整数（像素）。");
  }
  return Number(value);
}

function publicationDateFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { throw new Error("TELEGRAM_MARKDOWN_TIMEZONE / --timezone 不是有效时区。"); }
}

function publicationTimestamp(row: { sources?: unknown }): number | null {
  const source = Array.isArray(row.sources) ? row.sources[0] : undefined;
  const value = source && typeof source.date === "string" ? source.date : undefined;
  return !value || Number.isNaN(Date.parse(value)) ? null : Date.parse(value);
}

function formattedTimestamp(timestamp: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（${timeZone}）`;
}

type SortOrder = "asc" | "desc" | "source";

function parseSortOrder(value: string): SortOrder {
  if (value !== "asc" && value !== "desc" && value !== "source") throw new Error("TELEGRAM_MARKDOWN_SORT_ORDER / --sort-order 必须是 asc、desc 或 source。");
  return value;
}

export function readMarkdownOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  let input = environment.TELEGRAM_MARKDOWN_INPUT?.trim()
    || resolve(environment.TELEGRAM_SCAN_OUTPUT?.trim() || "weight-scan", environment.TELEGRAM_SCAN_EXPORT_FILE?.trim() || "folder-content.json");
  let output = environment.TELEGRAM_MARKDOWN_OUTPUT?.trim();
  let assetsDirectory = environment.TELEGRAM_MARKDOWN_ASSETS_DIR?.trim();
  let width = environment.TELEGRAM_MARKDOWN_IMAGE_WIDTH?.trim() || "120";
  let requireImages = environment.TELEGRAM_MARKDOWN_REQUIRE_IMAGES?.trim() || "true";
  let timeZone = environment.TELEGRAM_MARKDOWN_TIMEZONE?.trim() || "Asia/Shanghai";
  let sortOrder = environment.TELEGRAM_MARKDOWN_SORT_ORDER?.trim() || "asc";
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help") { help = true; continue; }
    if (arg === "--images-only") { requireImages = "true"; continue; }
    if (arg === "--include-text-only") { requireImages = "false"; continue; }
    if (!["--input", "--output", "--assets-dir", "--image-width", "--timezone", "--sort-order"].includes(arg)) throw new Error(`未知转换参数: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少路径。`);
    if (arg === "--input") input = value;
    else if (arg === "--output") output = value;
    else if (arg === "--assets-dir") assetsDirectory = value;
    else if (arg === "--image-width") width = value;
    else if (arg === "--timezone") timeZone = value;
    else sortOrder = value;
  }
  input = resolve(input);
  output = resolve(output || `${input.slice(0, input.length - extname(input).length)}.md`);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error("Markdown 输出路径不能与输入 JSON 相同。");
  if (![".md", ".markdown"].includes(extname(output).toLowerCase())) throw new Error("输出文件必须使用 .md 或 .markdown 扩展名。");
  assetsDirectory = resolve(dirname(output), assetsDirectory || `${basename(output, extname(output))}.assets`);
  if (!["true", "false"].includes(requireImages)) throw new Error("TELEGRAM_MARKDOWN_REQUIRE_IMAGES 必须是 true 或 false。");
  publicationDateFormatter(timeZone);
  return { input, output, assetsDirectory, imageWidth: imageWidth(width), requireImages: requireImages === "true", timeZone, sortOrder: parseSortOrder(sortOrder), help };
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type MarkdownAsset = { fileName: string; bytes: Buffer };

function imageAsset(value: unknown, context: string): MarkdownAsset {
  if (!value || typeof value !== "object" || !("base64" in value) || typeof value.base64 !== "string"
    || !("mimeType" in value) || typeof value.mimeType !== "string") throw new Error(`${context} 缺少 base64 或 mimeType。`);
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "image/gif": "gif", "image/bmp": "bmp", "image/avif": "avif", "image/svg+xml": "svg" };
  const extension = extensions[value.mimeType.toLowerCase()];
  if (typeof extension !== "string") throw new Error(`${context} 不支持图片类型 ${value.mimeType}。`);
  const bytes = Buffer.from(value.base64, "base64");
  if (!bytes.length || bytes.toString("base64") !== value.base64) throw new Error(`${context} 的 Base64 无效。`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if ("sha256" in value && value.sha256 !== hash) throw new Error(`${context} 的 SHA-256 校验失败。`);
  if ("byteLength" in value && value.byteLength !== bytes.length) throw new Error(`${context} 的字节数校验失败。`);
  return { fileName: `${hash}.${extension}`, bytes };
}

export function renderContentMarkdown(payload: unknown, imageUrlPrefix = "images", width = 120, requireImages = true, timeZone = "Asia/Shanghai", sortOrder: SortOrder = "asc") {
  const thumbnailWidth = imageWidth(width);
  const dateFormatter = publicationDateFormatter(timeZone);
  if (!payload || typeof payload !== "object" || !("records" in payload) || !Array.isArray(payload.records)) {
    throw new Error("输入 JSON 缺少 records 数组，请使用 scan 导出的 JSON。");
  }
  const folder = "folder" in payload && typeof payload.folder === "string" ? payload.folder : "Telegram";
  const order = parseSortOrder(sortOrder);
  const records = payload.records.map((row, index) => {
    if (!row || typeof row !== "object" || typeof row.text !== "string") throw new Error(`records[${index}].text 必须是字符串。`);
    return { row, index, timestamp: publicationTimestamp(row) };
  });
  if (order !== "source") {
    records.sort((left, right) => {
      if (left.timestamp === null) return right.timestamp === null ? left.index - right.index : 1;
      if (right.timestamp === null) return -1;
      return (order === "asc" ? 1 : -1) * (left.timestamp - right.timestamp) || left.index - right.index;
    });
  }
  const sections: string[] = [];
  const assets = new Map<string, MarkdownAsset>();
  let imageCount = 0;
  let skipped = 0;
  for (const { row, index, timestamp } of records) {
    if (row.images !== undefined && !Array.isArray(row.images)) throw new Error(`records[${index}].images 必须是数组。`);
    const images = (row.images ?? []).map((image: unknown, imageIndex: number) => {
      const asset = imageAsset(image, `records[${index}].images[${imageIndex}]`);
      if (!assets.has(asset.fileName)) assets.set(asset.fileName, asset);
      imageCount += 1;
      const url = htmlAttribute(`${imageUrlPrefix}/${asset.fileName}`);
      return `<a href="${url}"><img src="${url}" alt="图片 ${imageIndex + 1}" width="${thumbnailWidth}" loading="lazy"></a>`;
    });
    if (!images.length && (requireImages || !row.text.trim())) { skipped += 1; continue; }
    const text = row.text.trim() ? row.text.split(/\r\n|\n|\r/).map((line: string) => `> ${line}${line ? "  " : ""}`).join("\n") : "";
    // Zed routes standalone HTML blocks through its image parser, unlike bare inline HTML.
    const gallery = images.length ? `<p>\n${images.join(" ")}\n</p>` : "";
    const date = timestamp === null ? "未知" : formattedTimestamp(timestamp, dateFormatter, timeZone);
    sections.push([`## ${sections.length + 1}`, `发布日期：${date}`, text, gallery].filter(Boolean).join("\n\n"));
  }
  const incomplete = "complete" in payload && payload.complete === false ? "> 原始 JSON 标记为未完成采集，本文仅包含其中已导出的内容。\n\n" : "";
  const finishedAt = "finishedAt" in payload && typeof payload.finishedAt === "string" ? Date.parse(payload.finishedAt) : Number.NaN;
  const snapshot = Number.isNaN(finishedAt) ? "" : `快照采集完成：${formattedTimestamp(finishedAt, dateFormatter, timeZone)}\n\n`;
  const orderLabel = order === "asc" ? "发布日期从早到晚" : order === "desc" ? "发布日期从晚到早" : "原始 JSON 顺序";
  const markdown = `# ${inline(folder)} · 消息内容\n\n${incomplete}${snapshot}排序：${orderLabel}。\n\n共 ${payload.records.length} 条内容，导出 ${sections.length} 条${requireImages ? "带图片的" : ""}内容、${imageCount} 张图片，跳过 ${skipped} 条内容。\n\n${sections.join("\n\n---\n\n")}\n`;
  return { markdown, exported: sections.length, skipped, imageCount, assets: [...assets.values()] };
}

export async function writeContentMarkdown(payload: unknown, options: { output: string; assetsDirectory: string; imageWidth?: number; requireImages?: boolean; timeZone?: string; sortOrder?: SortOrder }) {
  const assetPath = relative(dirname(options.output), options.assetsDirectory);
  if (isAbsolute(assetPath)) throw new Error("图片目录必须与 Markdown 位于同一驱动器，以生成相对图片链接。");
  const prefix = assetPath.split(sep).map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/") || ".";
  const result = renderContentMarkdown(payload, prefix, options.imageWidth, options.requireImages, options.timeZone, options.sortOrder);
  await mkdir(dirname(options.output), { recursive: true });
  if (result.assets.length) await mkdir(options.assetsDirectory, { recursive: true });
  for (const asset of result.assets) await writeFile(resolve(options.assetsDirectory, asset.fileName), asset.bytes);
  await writeFile(options.output, result.markdown, "utf8");
  return result;
}

export async function jsonToMarkdown(argv: string[]): Promise<void> {
  loadEnvironment();
  const options = readMarkdownOptions(argv);
  if (options.help) {
    console.log("npm run json-to-markdown -- [--input <JSON路径>] [--output <Markdown路径>] [--assets-dir <图片目录>] [--image-width <像素>] [--timezone <时区>] [--sort-order asc|desc|source] [--include-text-only | --images-only]\n默认只保留带图片条目，按发布日期从早到晚排列；使用 TELEGRAM_MARKDOWN_SORT_ORDER 配置排序。每条标注原消息时间，默认 Asia/Shanghai，可用 TELEGRAM_MARKDOWN_TIMEZONE 配置。顶部标注快照采集时间，保留归档历史，不等同于实时频道列表。\n图片默认宽 120px，使用兼容 Zed 的独立 HTML 段落紧凑排列、自动换行，点击查看原图。不显示来源链接，不调用 Telegram、OCR 或模型。");
    return;
  }
  const payload: unknown = JSON.parse(await readFile(options.input, "utf8"));
  const result = await writeContentMarkdown(payload, options);
  console.log(`已转换 ${result.exported} 条内容、${result.imageCount} 张图片（${result.assets.length} 个图片文件），跳过 ${result.skipped} 条内容；输出：${options.output}\n图片目录：${options.assetsDirectory}`);
}
