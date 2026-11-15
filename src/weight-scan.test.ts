import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, TelegramClient, tl } from "@mtcute/node";
import { iterPosts, readScanOptions as readOptions, runScan, selectChannels } from "./weight-scan.js";
import type { CollectedDialog } from "./telegram.js";
import type { OpenAiConfig } from "./types.js";

const scanEnvironment = { TELEGRAM_SCAN_FOLDER: "小姐", TELEGRAM_SCAN_BELOW_JIN: "95" };
const readScanOptions = (args: string[]) => readOptions(args, scanEnvironment);

function message(id: number, album: string | null = null): Message {
  return { id, groupedIdUnique: album, date: new Date("2026-11-15T00:00:00Z"), isService: false, text: "90斤", media: null,
    link: `https://t.me/test/${id}` } as unknown as Message;
}
async function* history(messages: Message[]) { yield* messages; }
async function posts(messages: Message[], limit: number, since?: Date) {
  const result: number[][] = [];
  for await (const post of iterPosts(history(messages), { limit, since })) result.push(post.map((item) => item.id));
  return result;
}

test("all history, single messages, and complete albums at a limit boundary", async () => {
  const messages = [message(5), message(4, "album"), message(3, "album"), message(2)];
  assert.deepEqual(await posts(messages, 0), [[5], [4, 3], [2]]);
  assert.deepEqual(await posts(messages, 2), [[5], [4, 3]]);
  assert.deepEqual(await posts(messages, 1), [[5]]);
  assert.deepEqual(await posts([], 0), []);
  assert.deepEqual(await posts(messages, 0, new Date("2026-11-16")), []);
});

test("date cutoff retains the rest of a boundary album", async () => {
  const older = { ...message(3, "album"), date: new Date("2026-11-13") } as Message;
  assert.deepEqual(await posts([message(4, "album"), older, message(2)], 0, new Date("2026-11-14")), [[4, 3], [2]]);
});

test("options validate limits, dates, threshold and unknown flags before Telegram login", () => {
  assert.equal(readScanOptions([]).folder, "小姐");
  assert.equal(readScanOptions(["--limit", "100", "--below", "94.5"]).limit, 100);
  assert.equal(readScanOptions(["--dry-run"]).dryRun, true);
  for (const args of [["--limit", "-1"], ["--limit", "1.5"], ["--below", "0"], ["--since", "2026-02-30"], ["--since", "2026-11-01T00:00:00"], ["--folder"], ["--typo"]]) {
    assert.throws(() => readScanOptions(args), args.join(" "));
  }
});

test("environment settings configure the scan and CLI takes precedence", () => {
  const environment = { TELEGRAM_SCAN_FOLDER: "测试频道", TELEGRAM_SCAN_BELOW_JIN: "90", TELEGRAM_SCAN_LIMIT: "7",
    TELEGRAM_SCAN_SINCE: "2026-11-01", TELEGRAM_SCAN_OUTPUT: "custom-scan", TELEGRAM_SCAN_DRY_RUN: "true",
    TELEGRAM_SCAN_IMAGE_MAX_MIB: "2.5", TELEGRAM_SCAN_ALBUM_MAX_MIB: "5", TELEGRAM_SCAN_REQUEST_TIMEOUT_MS: "3000" };
  const options = readOptions([], environment);
  assert.equal(options.folder, "测试频道");
  assert.equal(options.below, 90);
  assert.equal(options.limit, 7);
  assert.equal(options.since?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.ok(options.output.endsWith("custom-scan"));
  assert.equal(options.dryRun, true);
  assert.equal(options.maxImageBytes, 2.5 * 1024 * 1024);
  assert.equal(options.maxAlbumBytes, 5 * 1024 * 1024);
  assert.equal(options.requestTimeoutMs, 3000);
  const overridden = readOptions(["--folder", "命令行", "--below", "80", "--limit", "3", "--since", "2026-11-02", "--output", "cli-scan", "--no-dry-run"], environment);
  assert.equal(overridden.folder, "命令行");
  assert.equal(overridden.below, 80);
  assert.equal(overridden.limit, 3);
  assert.equal(overridden.since?.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.ok(overridden.output.endsWith("cli-scan"));
  assert.equal(overridden.dryRun, false);
  assert.equal(readOptions(["--below", "80"], { ...environment, TELEGRAM_SCAN_BELOW_JIN: "invalid" }).below, 80);
});

test("missing and malformed environment values fail before network access; help needs no config", () => {
  assert.equal(readOptions(["--help"], {}).help, true);
  assert.throws(() => readOptions([], {}), /TELEGRAM_SCAN_FOLDER/);
  assert.throws(() => readOptions([], { TELEGRAM_SCAN_FOLDER: "test" }), /TELEGRAM_SCAN_BELOW_JIN/);
  for (const [key, value] of Object.entries({ TELEGRAM_SCAN_BELOW_JIN: "NaN", TELEGRAM_SCAN_LIMIT: "-1",
    TELEGRAM_SCAN_SINCE: "2026-02-30", TELEGRAM_SCAN_DRY_RUN: "yes", TELEGRAM_SCAN_IMAGE_MAX_MIB: "Infinity",
    TELEGRAM_SCAN_ALBUM_MAX_MIB: "0", TELEGRAM_SCAN_REQUEST_TIMEOUT_MS: "2147483648" })) {
    assert.throws(() => readOptions([], { ...scanEnvironment, [key]: value }), new RegExp(key));
  }
});

function channel(id: number, title: string, kind = "channel"): CollectedDialog {
  const peer = { _: "inputPeerChannel", channelId: id, accessHash: 1 };
  return { info: { id: -1000000000000 - id, title, inputPeer: peer, entityKind: kind },
    dialog: { peer: { id: -1000000000000 - id } } } as unknown as CollectedDialog;
}

test("folder selection includes pinned-only channels and rejects ambiguous titles", () => {
  const pinned = channel(1, "pinned");
  const included = channel(2, "included");
  const group = channel(3, "group", "supergroup");
  const folder = { _: "dialogFilterChatlist", id: 5, title: { _: "textWithEntities", text: "小姐", entities: [] },
    pinnedPeers: [pinned.info.inputPeer], includePeers: [included.info.inputPeer, group.info.inputPeer] } as tl.RawDialogFilterChatlist;
  assert.deepEqual(selectChannels([pinned, included, group, channel(4, "other")], [folder], "小姐"), [pinned, included]);
  assert.throws(() => selectChannels([], [], "小姐"));
  assert.throws(() => selectChannels([], [folder, folder], "小姐"));
});

test("reports preserve source, cache successful analysis, and re-evaluate thresholds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-weight-test-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const api: OpenAiConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-key", model: "test-vision",
    apiStyle: "chat", maxRetries: 1, retryDelaySeconds: 0, batchSize: 1, rules: [] };
  const client = { iterHistory: () => history([message(1)]) } as unknown as TelegramClient;
  const options = { ...readScanOptions([]), output: directory };
  try {
    globalThis.fetch = async () => {
      requests += 1;
      return Response.json({ choices: [{ message: { content: '{"summary":"测试摘要","ocr":[]}' } }] });
    };
    await runScan(client, [channel(1, "test")], api, options);
    const match = JSON.parse((await readFile(join(directory, "matches.jsonl"), "utf8")).trim());
    assert.equal(match.texts[0].text, "90斤");
    assert.equal(match.links[0], "https://t.me/test/1");
    assert.equal(match.analysis.summary, "测试摘要");
    await runScan(client, [channel(1, "test")], api, { ...options, below: 90 });
    assert.equal(requests, 1);
    assert.equal(await readFile(join(directory, "matches.jsonl"), "utf8"), "");
    const stats = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    assert.equal(stats.cached, 1);
    assert.equal(stats.excluded, 1);
    assert.equal(stats.complete, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const file of await readdir(join(directory, "cache"))) await unlink(join(directory, "cache", file));
    await rmdir(join(directory, "cache"));
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
});

test("image-only albums use OCR evidence; failed analyses persist and are retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-weight-test-"));
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  const photo = { ...message(1, "album"), text: "", media: { type: "photo", uniqueFileId: "photo-1", fileSize: 4 } } as unknown as Message;
  const client = { iterHistory: () => history([photo]), downloadAsBuffer: async () => { downloads += 1; return new Uint8Array([1, 2, 3, 4]); } } as unknown as TelegramClient;
  const api: OpenAiConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-key", model: "test-vision",
    apiStyle: "chat", maxRetries: 1, retryDelaySeconds: 0, batchSize: 1, rules: [] };
  const options = { ...readScanOptions([]), output: directory };
  try {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(runScan(client, [channel(1, "test")], api, options), /扫描存在失败/);
    const failed = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    assert.equal(failed.complete, false);
    assert.equal(failed.review, 1);
    assert.equal((await readdir(join(directory, "cache"))).length, 0);
    assert.equal((await readdir(directory)).includes(".scan.lock"), false);
    assert.equal(JSON.parse((await readFile(join(directory, "review.jsonl"), "utf8")).trim()).decision.status, "review");

    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.messages[1].content.at(-1).image_url.url, "data:image/jpeg;base64,AQIDBA==");
      return Response.json({ choices: [{ message: { content: '{"summary":"仅图片","ocr":[{"messageId":1,"text":"体重45kg","uncertain":false}]}' } }] });
    };
    await runScan(client, [channel(1, "test")], api, options);
    const matched = JSON.parse((await readFile(join(directory, "matches.jsonl"), "utf8")).trim());
    assert.equal(matched.decision.weights[0].source, "ocr");
    assert.equal(matched.decision.weights[0].jin, 90);
    await runScan(client, [channel(1, "test")], api, options);
    assert.equal(downloads, 2, "cache avoids repeated image downloads");
  } finally {
    globalThis.fetch = originalFetch;
    for (const file of await readdir(join(directory, "cache"))) await unlink(join(directory, "cache", file));
    await rmdir(join(directory, "cache"));
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
});

test("history errors produce incomplete reports and do not prevent other channels from finishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-weight-test-"));
  const client = { iterHistory: (peer: tl.RawInputPeerChannel) => (async function* () {
    if (peer.channelId === 1) throw new Error("CHANNEL_PRIVATE");
  })() } as unknown as TelegramClient;
  const api: OpenAiConfig = { baseUrl: "https://example.invalid/v1", apiKey: "test-key", model: "test-vision",
    apiStyle: "chat", maxRetries: 1, retryDelaySeconds: 0, batchSize: 1, rules: [] };
  try {
    await assert.rejects(runScan(client, [channel(1, "private"), channel(2, "empty")], api, { ...readScanOptions([]), output: directory }));
    const stats = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    assert.equal(stats.complete, false);
    assert.equal(stats.channelsCompleted, 1);
    assert.equal(stats.errors[0].error, "CHANNEL_PRIVATE");
  } finally {
    await rmdir(join(directory, "cache"));
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
});
