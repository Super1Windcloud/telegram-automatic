import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readMarkdownOptions, renderContentMarkdown, writeContentMarkdown } from "./json-to-markdown.js";

const image = { mimeType: "image/gif", base64: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" };

test("text and image-only posts render images without source metadata or inline Base64", () => {
  const result = renderContentMarkdown({ folder: "测试", complete: true, records: [
    { text: "原文第一行\r\n体重90斤\n\n末行", sources: [
      { channelTitle: "频道A", date: "2026-11-15T00:00:00Z", links: ["https://t.me/test/1"] },
      { channelTitle: "频道B", date: "2026-11-16T00:00:00Z", links: ["https://t.me/test/2"] },
    ], images: [image] },
    { text: " \n\t", images: [image] },
    { text: "", images: [] },
  ] });
  assert.equal(result.exported, 2);
  assert.equal(result.skipped, 1);
  for (const text of ["原文第一行", "体重90斤", "末行"]) assert.ok(result.markdown.includes(text));
  for (const source of ["来源：", "频道A", "频道B", "2026-11-15T00:00:00Z", "https://t.me/test/1", "https://t.me/test/2"]) assert.equal(result.markdown.includes(source), false);
  assert.match(result.markdown, /原文第一行  \n> 体重90斤/);
  assert.equal(result.markdown.includes(image.base64), false);
  assert.equal(result.imageCount, 2);
  assert.equal(result.assets.length, 1, "identical images share an asset without merging posts");
  assert.equal((result.markdown.match(/<img src="images\//g) ?? []).length, 2);
  assert.ok(result.markdown.includes('width="120" loading="lazy"'));
  assert.deepEqual(result.assets[0].bytes, Buffer.from(image.base64, "base64"));
});

test("incomplete and malformed text is handled explicitly while unused sources are omitted", () => {
  const result = renderContentMarkdown({ complete: false, records: [{ text: "保留", images: [image], sources: [
    { channelTitle: "[伪链接](bad)", links: ["javascript:alert(1)", "https://t.me/test/(1)"] },
  ] }] });
  assert.ok(result.markdown.includes("未完成采集"));
  assert.equal(result.markdown.includes("javascript:"), false);
  assert.equal(result.markdown.includes("https://t.me/test/"), false);
  assert.doesNotThrow(() => renderContentMarkdown({ records: [{ text: "x", sources: {} }] }));
  for (const input of [null, [], {}, { records: [{}] }, { records: [{ text: 1 }] }]) {
    assert.throws(() => renderContentMarkdown(input));
  }
});

test("input defaults follow scan output; environment and CLI paths override defaults", () => {
  const defaults = readMarkdownOptions([], { TELEGRAM_SCAN_OUTPUT: "custom", TELEGRAM_SCAN_EXPORT_FILE: "export.json" });
  assert.equal(defaults.input, resolve("custom/export.json"));
  assert.equal(defaults.output, resolve("custom/export.md"));
  assert.equal(defaults.assetsDirectory, resolve("custom/export.assets"));
  assert.equal(defaults.imageWidth, 120);
  assert.equal(defaults.requireImages, true);
  assert.equal(readMarkdownOptions([], { TELEGRAM_MARKDOWN_REQUIRE_IMAGES: "false" }).requireImages, false);
  assert.equal(readMarkdownOptions(["--images-only"], { TELEGRAM_MARKDOWN_REQUIRE_IMAGES: "false" }).requireImages, true);
  assert.equal(readMarkdownOptions(["--include-text-only"], {}).requireImages, false);
  assert.throws(() => readMarkdownOptions([], { TELEGRAM_MARKDOWN_REQUIRE_IMAGES: "yes" }));
  assert.equal(readMarkdownOptions([], { TELEGRAM_MARKDOWN_IMAGE_WIDTH: "96" }).imageWidth, 96);
  assert.equal(readMarkdownOptions(["--image-width", "80"], { TELEGRAM_MARKDOWN_IMAGE_WIDTH: "96" }).imageWidth, 80);
  for (const width of ["0", "-1", "12.5", "100px", "NaN"]) assert.throws(() => readMarkdownOptions(["--image-width", width], {}));
  const configured = readMarkdownOptions([], { TELEGRAM_MARKDOWN_INPUT: "a.json", TELEGRAM_MARKDOWN_OUTPUT: "a.md" });
  assert.equal(configured.input, resolve("a.json"));
  const cli = readMarkdownOptions(["--input", "b.json", "--output", "b.md"], { TELEGRAM_MARKDOWN_INPUT: "a.json", TELEGRAM_MARKDOWN_OUTPUT: "a.md" });
  assert.equal(cli.input, resolve("b.json"));
  assert.equal(cli.output, resolve("b.md"));
  assert.equal(readMarkdownOptions(["--output", "out/b.md", "--assets-dir", "photos"], {}).assetsDirectory, resolve("out/photos"));
  assert.equal(readMarkdownOptions([], { TELEGRAM_MARKDOWN_OUTPUT: "out/c.md", TELEGRAM_MARKDOWN_ASSETS_DIR: "images" }).assetsDirectory, resolve("out/images"));
  assert.throws(() => readMarkdownOptions(["--input", "a.json", "--output", "a.json"], {}));
  assert.throws(() => readMarkdownOptions(["--output", "out.txt"], {}));
  assert.throws(() => readMarkdownOptions(["--input"], {}));
  assert.throws(() => readMarkdownOptions(["--unknown"], {}));
});

test("image filtering drops text-only records, keeps image-only records and renumbers sections", () => {
  const payload = { records: [{ text: "纯文字不应导出", images: [] }, { text: "保留图文", images: [image] },
    { text: "", images: [image] }, { text: "", images: [] }] };
  const filtered = renderContentMarkdown(payload);
  assert.equal(filtered.exported, 2);
  assert.equal(filtered.skipped, 2);
  assert.equal(filtered.imageCount, 2);
  assert.equal(filtered.markdown.includes("纯文字不应导出"), false);
  assert.ok(filtered.markdown.includes("保留图文"));
  assert.deepEqual([...filtered.markdown.matchAll(/^## (\d+)$/gm)].map((match) => Number(match[1])), [1, 2]);
  const unfiltered = renderContentMarkdown(payload, "images", 120, false);
  assert.equal(unfiltered.exported, 3);
  assert.equal(unfiltered.skipped, 1);
  assert.ok(unfiltered.markdown.includes("纯文字不应导出"));
});

test("invalid image data and mismatched checksums are rejected", () => {
  for (const invalid of [
    { ...image, base64: "not base64!" }, { ...image, sha256: "wrong" }, { ...image, byteLength: 999 },
    { ...image, mimeType: "video/mp4" }, { mimeType: "image/png" },
  ]) {
    assert.throws(() => renderContentMarkdown({ records: [{ text: "内容", images: [invalid] }] }));
  }
});

test("written Markdown image paths resolve to real files with Chinese names and spaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-md-test-"));
  const outputDirectory = join(directory, "with spaces");
  const options = { output: join(outputDirectory, "内容.md"), assetsDirectory: join(outputDirectory, "图片 assets (1)") };
  try {
    const result = await writeContentMarkdown({ records: [{ text: "", images: [image, image] }] }, options);
    const markdown = await readFile(options.output, "utf8");
    const paths = [...markdown.matchAll(/<img src="([^"]+)"/g)].map((match) => resolve(outputDirectory, decodeURIComponent(match[1])));
    assert.equal(paths.length, 2);
    assert.equal(paths[0], paths[1]);
    assert.deepEqual(await readFile(paths[0]), Buffer.from(image.base64, "base64"));
    assert.equal((await readdir(options.assetsDirectory)).length, 1);
    assert.equal(result.exported, 1);
  } finally {
    for (const file of await readdir(options.assetsDirectory)) await unlink(join(options.assetsDirectory, file));
    await rmdir(options.assetsDirectory);
    await unlink(options.output);
    await rmdir(outputDirectory);
    await rmdir(directory);
  }
});

test("thumbnails form a standalone HTML block for Zed, keep compact width and link to full images", () => {
  const result = renderContentMarkdown({ records: [{ text: "图文", images: [image, image, image] }] }, "images", 88);
  const blocks = [...result.markdown.matchAll(/^<p>\n([\s\S]*?)\n<\/p>$/gm)];
  assert.equal(blocks.length, 1, "Zed parses image groups through its HTML-block renderer");
  assert.doesNotMatch(blocks[0][1], /\n\s*\n/, "blank lines would end the Markdown HTML block early");
  assert.equal((blocks[0][1].match(/<img /g) ?? []).length, 3);
  assert.match(result.markdown, /<\/a> <a href=/);
  assert.doesNotMatch(result.markdown, /<\/a>\n\n<a/);
  const thumbnails = [...result.markdown.matchAll(/<a href="([^"]+)"><img src="([^"]+)" alt="图片 (\d+)" width="(\d+)" loading="lazy"><\/a>/g)];
  assert.equal(thumbnails.length, 3);
  for (const thumbnail of thumbnails) {
    assert.equal(thumbnail[1], thumbnail[2]);
    assert.equal(thumbnail[4], "88");
  }
  const escaped = renderContentMarkdown({ records: [{ text: "", images: [image] }] }, 'images" onerror="bad');
  assert.ok(escaped.markdown.includes("&quot;"));
  assert.equal(escaped.markdown.includes(' onerror="bad'), false);
});
