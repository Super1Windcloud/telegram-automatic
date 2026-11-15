import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadEnvironment } from "./env.js";

export function readMarkdownOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  let input = environment.TELEGRAM_MARKDOWN_INPUT?.trim()
    || resolve(environment.TELEGRAM_SCAN_OUTPUT?.trim() || "weight-scan", environment.TELEGRAM_SCAN_EXPORT_FILE?.trim() || "folder-content.json");
  let output = environment.TELEGRAM_MARKDOWN_OUTPUT?.trim();
  let assetsDirectory = environment.TELEGRAM_MARKDOWN_ASSETS_DIR?.trim();
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help") { help = true; continue; }
    if (arg !== "--input" && arg !== "--output" && arg !== "--assets-dir") throw new Error(`未知转换参数: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少路径。`);
    if (arg === "--input") input = value;
    else if (arg === "--output") output = value;
    else assetsDirectory = value;
  }
  input = resolve(input);
  output = resolve(output || `${input.slice(0, input.length - extname(input).length)}.md`);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error("Markdown 输出路径不能与输入 JSON 相同。");
  if (![".md", ".markdown"].includes(extname(output).toLowerCase())) throw new Error("输出文件必须使用 .md 或 .markdown 扩展名。");
  assetsDirectory = resolve(dirname(output), assetsDirectory || `${basename(output, extname(output))}.assets`);
  return { input, output, assetsDirectory, help };
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
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

export function renderContentMarkdown(payload: unknown, imageUrlPrefix = "images") {
  if (!payload || typeof payload !== "object" || !("records" in payload) || !Array.isArray(payload.records)) {
    throw new Error("输入 JSON 缺少 records 数组，请使用 scan 导出的 JSON。");
  }
  const folder = "folder" in payload && typeof payload.folder === "string" ? payload.folder : "Telegram";
  const sections: string[] = [];
  const assets = new Map<string, MarkdownAsset>();
  let imageCount = 0;
  let skipped = 0;
  for (const [index, row] of payload.records.entries()) {
    if (!row || typeof row !== "object" || typeof row.text !== "string") throw new Error(`records[${index}].text 必须是字符串。`);
    if (row.images !== undefined && !Array.isArray(row.images)) throw new Error(`records[${index}].images 必须是数组。`);
    const images = (row.images ?? []).map((image: unknown, imageIndex: number) => {
      const asset = imageAsset(image, `records[${index}].images[${imageIndex}]`);
      if (!assets.has(asset.fileName)) assets.set(asset.fileName, asset);
      imageCount += 1;
      return `![图片 ${imageIndex + 1}](${imageUrlPrefix}/${asset.fileName})`;
    });
    if (!row.text.trim() && !images.length) { skipped += 1; continue; }
    const text = row.text.trim() ? row.text.split(/\r\n|\n|\r/).map((line: string) => `> ${line}${line ? "  " : ""}`).join("\n") : "";
    sections.push([`## ${sections.length + 1}`, text, ...images].filter(Boolean).join("\n\n"));
  }
  const incomplete = "complete" in payload && payload.complete === false ? "> 原始 JSON 标记为未完成采集，本文仅包含其中已导出的内容。\n\n" : "";
  const markdown = `# ${inline(folder)} · 消息内容\n\n${incomplete}共 ${payload.records.length} 条内容，导出 ${sections.length} 条内容、${imageCount} 张图片，跳过 ${skipped} 条空内容。\n\n${sections.join("\n\n---\n\n")}\n`;
  return { markdown, exported: sections.length, skipped, imageCount, assets: [...assets.values()] };
}

export async function writeContentMarkdown(payload: unknown, options: { output: string; assetsDirectory: string }) {
  const assetPath = relative(dirname(options.output), options.assetsDirectory);
  if (isAbsolute(assetPath)) throw new Error("图片目录必须与 Markdown 位于同一驱动器，以生成相对图片链接。");
  const prefix = assetPath.split(sep).map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/") || ".";
  const result = renderContentMarkdown(payload, prefix);
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
    console.log("npm run json-to-markdown -- [--input <JSON路径>] [--output <Markdown路径>] [--assets-dir <图片目录>]\n默认读取扫描 JSON，生成同名 .md 和 .assets 图片目录；支持 TELEGRAM_MARKDOWN_INPUT / TELEGRAM_MARKDOWN_OUTPUT / TELEGRAM_MARKDOWN_ASSETS_DIR。\n仅导出文字及图片，不显示来源；以相对路径渲染图片，不调用 Telegram、OCR 或模型。");
    return;
  }
  const payload: unknown = JSON.parse(await readFile(options.input, "utf8"));
  const result = await writeContentMarkdown(payload, options);
  console.log(`已转换 ${result.exported} 条内容、${result.imageCount} 张图片（${result.assets.length} 个图片文件），跳过 ${result.skipped} 条空内容；输出：${options.output}\n图片目录：${options.assetsDirectory}`);
}
