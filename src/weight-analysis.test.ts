import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeContent, decideWeight, parseAnalysis } from "./weight-analysis.js";
import type { OpenAiConfig } from "./types.js";

const api: OpenAiConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-key", model: "test-vision",
  apiStyle: "auto", maxRetries: 2, retryDelaySeconds: 0, batchSize: 1, rules: [] };
const decision = (text: string) => decideWeight([{ messageId: 1, text }], [], 95);

test("strict threshold and unit conversion, including full-width OCR", () => {
  for (const text of ["体重：90斤", "身高165 体重90斤", "体重: 45 KG", "身高165，体重４５公斤", "90lb", "90磅", "体重 90.5斤"]) {
    assert.equal(decision(text).status, "matched", text);
  }
  for (const text of ["95斤", "47.5kg", "体重96斤", "体重:100公斤"]) assert.equal(decision(text).status, "excluded", text);
  assert.equal(decision("45kg").weights[0].jin, 90);
});

test("ranges, comparisons, unitless labels and invalid values require review", () => {
  for (const text of ["体重90", "体重:45.5", "90-100斤", "90～100斤", "约90斤", "不到95斤", "90斤以下", "不超过90斤", "不是90斤", "体重0斤", "-90斤", "90斤，100斤"]) {
    assert.equal(decision(text).status, "review", text);
  }
  for (const text of ["身高165 年龄22 价格90", "165/90/B", "没有体重信息"]) assert.equal(decision(text).status, "unknown", text);
});

test("only source evidence affects weights; OCR conflict and uncertainty require review", () => {
  const texts = [{ messageId: 1, text: "90斤" }];
  assert.equal(decideWeight(texts, [{ messageId: 2, text: "45kg", uncertain: false }], 95).status, "matched");
  assert.equal(decideWeight(texts, [{ messageId: 2, text: "100斤", uncertain: false }], 95).status, "review");
  assert.equal(decideWeight(texts, [{ messageId: 2, text: "", uncertain: true }], 95).status, "review");
  assert.equal(decideWeight([], [], 95).status, "unknown");
});

test("OCR response cannot omit, duplicate or invent an image", () => {
  const row = { messageId: 2, text: "45kg", uncertain: false };
  const json = (ocr: unknown[]) => JSON.stringify({ summary: "体重90斤", ocr });
  assert.deepEqual(parseAnalysis(json([row]), [2]).ocr, [row]);
  assert.throws(() => parseAnalysis(json([]), [2]));
  assert.throws(() => parseAnalysis(json([row, row]), [2]));
  assert.throws(() => parseAnalysis(json([row]), [3]));
  assert.throws(() => parseAnalysis(json([{ ...row, uncertain: "false" }]), [2]));
});

test("chat sends image data and retries 429 without losing evidence", async () => {
  const calls: Array<{ url: string; payload: any }> = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), payload: JSON.parse(String(init?.body)) });
    if (calls.length === 1) return new Response("rate limited", { status: 429 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "文字摘要", ocr: [{ messageId: 2, text: "45kg", uncertain: false }] }) } }] });
  };
  const result = await analyzeContent(api, [{ messageId: 1, text: "原文" }], [{ messageId: 2, dataUrl: "data:image/png;base64,AAAA" }], request);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://example.invalid/v1/chat/completions");
  assert.equal(calls[1].payload.messages[1].content.at(-1).image_url.url, "data:image/png;base64,AAAA");
  assert.equal(result.ocr[0].text, "45kg");
});

test("auto falls back on an unavailable endpoint; responses maps image fields", async () => {
  const calls: Array<{ url: string; payload: any }> = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), payload: JSON.parse(String(init?.body)) });
    if (calls.length === 1) return new Response(null, { status: 404 });
    return Response.json({ output: [{ content: [{ type: "output_text", text: '{"summary":"摘要","ocr":[{"messageId":2,"text":"90斤","uncertain":false}]}' }] }] });
  };
  await analyzeContent({ ...api, baseUrl: "https://example.invalid/v1/responses" }, [], [{ messageId: 2, dataUrl: "data:image/png;base64,AAAA" }], request);
  assert.equal(calls[1].url, "https://example.invalid/v1/responses");
  assert.equal(calls[1].payload.store, false);
  assert.equal(calls[1].payload.input[0].content.at(-1).type, "input_image");
});

test("auth failures do not trigger retries or expose provider response bodies", async () => {
  let calls = 0;
  await assert.rejects(analyzeContent(api, [], [], async () => {
    calls += 1;
    return new Response("secret-provider-error", { status: 401 });
  }), (error: Error) => error.message.includes("401") && !error.message.includes("secret-provider-error"));
  assert.equal(calls, 1);
});
