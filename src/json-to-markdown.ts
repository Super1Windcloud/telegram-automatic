import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { loadEnvironment } from "./env.js";

export function readMarkdownOptions(argv: string[], environment: NodeJS.ProcessEnv = process.env) {
  let input = environment.TELEGRAM_MARKDOWN_INPUT?.trim()
    || resolve(environment.TELEGRAM_SCAN_OUTPUT?.trim() || "weight-scan", environment.TELEGRAM_SCAN_EXPORT_FILE?.trim() || "folder-content.json");
  let output = environment.TELEGRAM_MARKDOWN_OUTPUT?.trim();
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help") { help = true; continue; }
    if (arg !== "--input" && arg !== "--output") throw new Error(`未知转换参数: ${arg}`);
    const value = argv[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少路径。`);
    if (arg === "--input") input = value;
    else output = value;
  }
  input = resolve(input);
  output = resolve(output || `${input.slice(0, input.length - extname(input).length)}.md`);
  if (input.toLowerCase() === output.toLowerCase()) throw new Error("Markdown 输出路径不能与输入 JSON 相同。");
  if (![".md", ".markdown"].includes(extname(output).toLowerCase())) throw new Error("输出文件必须使用 .md 或 .markdown 扩展名。");
  return { input, output, help };
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

function sourceLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (typeof link !== "string") return [];
    try {
      const url = new URL(link);
      if (url.protocol !== "https:" && url.protocol !== "http:") return [];
      return [`[原消息](${url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`];
    } catch { return []; }
  });
}

export function renderContentMarkdown(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("records" in payload) || !Array.isArray(payload.records)) {
    throw new Error("输入 JSON 缺少 records 数组，请使用 scan 导出的 JSON。");
  }
  const folder = "folder" in payload && typeof payload.folder === "string" ? payload.folder : "Telegram";
  const sections: string[] = [];
  let skipped = 0;
  for (const [index, row] of payload.records.entries()) {
    if (!row || typeof row !== "object" || typeof row.text !== "string") throw new Error(`records[${index}].text 必须是字符串。`);
    if (!row.text.trim()) { skipped += 1; continue; }
    if (row.sources !== undefined && !Array.isArray(row.sources)) throw new Error(`records[${index}].sources 必须是数组。`);
    const sources = (row.sources ?? []).map((source: unknown) => {
      if (!source || typeof source !== "object") throw new Error(`records[${index}].sources 来源格式无效。`);
      const title = "channelTitle" in source && typeof source.channelTitle === "string" ? source.channelTitle : "未知频道";
      const date = "date" in source && typeof source.date === "string" ? source.date : "";
      const links = sourceLinks("links" in source ? source.links : undefined);
      return `- ${[inline(title), inline(date), ...links].filter(Boolean).join(" · ")}`;
    });
    const text = row.text.split(/\r\n|\n|\r/).map((line: string) => `> ${line}${line ? "  " : ""}`).join("\n");
    sections.push(`## ${sections.length + 1}\n\n${text}${sources.length ? `\n\n来源：\n\n${sources.join("\n")}` : ""}`);
  }
  const incomplete = "complete" in payload && payload.complete === false ? "> 原始 JSON 标记为未完成采集，本文仅包含其中已导出的文字。\n\n" : "";
  const markdown = `# ${inline(folder)} · 消息文字\n\n${incomplete}共 ${payload.records.length} 条内容，导出 ${sections.length} 条文字，跳过 ${skipped} 条空文字内容。\n\n${sections.join("\n\n---\n\n")}\n`;
  return { markdown, exported: sections.length, skipped };
}

export async function jsonToMarkdown(argv: string[]): Promise<void> {
  loadEnvironment();
  const options = readMarkdownOptions(argv);
  if (options.help) {
    console.log("npm run json-to-markdown -- [--input <JSON路径>] [--output <Markdown路径>]\n默认读取扫描导出的 JSON，并在同目录生成同名 .md；也可配置 TELEGRAM_MARKDOWN_INPUT / TELEGRAM_MARKDOWN_OUTPUT。\n仅转换 records[].text 并保留来源，跳过空文字及图片，不调用 Telegram、OCR 或模型。");
    return;
  }
  const payload: unknown = JSON.parse(await readFile(options.input, "utf8"));
  const result = renderContentMarkdown(payload);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, result.markdown, "utf8");
  console.log(`已转换 ${result.exported} 条文字，跳过 ${result.skipped} 条空文字内容；输出：${options.output}`);
}
