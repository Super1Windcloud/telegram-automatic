import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readMarkdownOptions, renderContentMarkdown } from "./json-to-markdown.js";

test("text export preserves line breaks and all sources without embedding image data", () => {
  const result = renderContentMarkdown({ folder: "测试", complete: true, records: [
    { text: "原文第一行\r\n体重90斤\n\n末行", sources: [
      { channelTitle: "频道A", date: "2026-11-15T00:00:00Z", links: ["https://t.me/test/1"] },
      { channelTitle: "频道B", date: "2026-11-16T00:00:00Z", links: ["https://t.me/test/2"] },
    ], images: [{ base64: "NEVER_EMBED_IMAGE_DATA" }] },
    { text: " \n\t", images: [{ base64: "ALSO_OMIT_THIS" }] },
  ] });
  assert.equal(result.exported, 1);
  assert.equal(result.skipped, 1);
  for (const text of ["原文第一行", "体重90斤", "末行", "频道A", "频道B", "https://t.me/test/1", "https://t.me/test/2"]) assert.ok(result.markdown.includes(text));
  assert.match(result.markdown, /原文第一行  \n> 体重90斤/);
  assert.equal(result.markdown.includes("EMBED_IMAGE"), false);
  assert.equal(result.markdown.includes("ALSO_OMIT"), false);
});

test("incomplete and malformed input is handled explicitly; source URLs cannot inject executable links", () => {
  const result = renderContentMarkdown({ complete: false, records: [{ text: "保留", sources: [
    { channelTitle: "[伪链接](bad)", links: ["javascript:alert(1)", "https://t.me/test/(1)"] },
  ] }] });
  assert.ok(result.markdown.includes("未完成采集"));
  assert.equal(result.markdown.includes("javascript:"), false);
  assert.ok(result.markdown.includes("https://t.me/test/%281%29"));
  for (const input of [null, [], {}, { records: [{}] }, { records: [{ text: 1 }] }, { records: [{ text: "x", sources: {} }] }]) {
    assert.throws(() => renderContentMarkdown(input));
  }
});

test("input defaults follow scan output; environment and CLI paths override defaults", () => {
  const defaults = readMarkdownOptions([], { TELEGRAM_SCAN_OUTPUT: "custom", TELEGRAM_SCAN_EXPORT_FILE: "export.json" });
  assert.equal(defaults.input, resolve("custom/export.json"));
  assert.equal(defaults.output, resolve("custom/export.md"));
  const configured = readMarkdownOptions([], { TELEGRAM_MARKDOWN_INPUT: "a.json", TELEGRAM_MARKDOWN_OUTPUT: "a.md" });
  assert.equal(configured.input, resolve("a.json"));
  const cli = readMarkdownOptions(["--input", "b.json", "--output", "b.md"], { TELEGRAM_MARKDOWN_INPUT: "a.json", TELEGRAM_MARKDOWN_OUTPUT: "a.md" });
  assert.equal(cli.input, resolve("b.json"));
  assert.equal(cli.output, resolve("b.md"));
  assert.throws(() => readMarkdownOptions(["--input", "a.json", "--output", "a.json"], {}));
  assert.throws(() => readMarkdownOptions(["--output", "out.txt"], {}));
  assert.throws(() => readMarkdownOptions(["--input"], {}));
  assert.throws(() => readMarkdownOptions(["--unknown"], {}));
});
