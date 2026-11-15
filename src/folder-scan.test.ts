import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, TelegramClient } from "@mtcute/node";
import type { CollectedDialog } from "./telegram.js";
import { exportFolderContents, normalizedText, readExportOptions } from "./folder-scan.js";

function message(id: number, text: string, media: unknown = null, album: string | null = null): Message {
  return { id, text, media, groupedIdUnique: album, date: new Date("2026-11-15T00:00:00Z"), isService: false,
    link: `https://t.me/test/${id}` } as unknown as Message;
}
const photo = (id: string, size = 3) => ({ type: "photo", fileId: id, fileSize: size, dcId: 5 });
const channel = (id: number) => ({ info: { id, title: `channel-${id}`, inputPeer: { channelId: id } } }) as unknown as CollectedDialog;
async function* history(messages: Message[]) { yield* messages; }
async function clean(directory: string) {
  for (const file of await readdir(directory)) await unlink(join(directory, file));
  await rmdir(directory);
}

test("collection options require neither weight nor model configuration", () => {
  const options = readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test", TELEGRAM_SCAN_BELOW_JIN: "invalid", TELEGRAM_SCAN_REQUEST_TIMEOUT_MS: "invalid" });
  assert.equal(options.folder, "test");
  assert.equal(options.limit, 0);
  assert.ok(options.exportFile.endsWith("folder-content.json"));
  assert.throws(() => readExportOptions(["--below", "95"], { TELEGRAM_SCAN_FOLDER: "test" }), /仅采集/);
  assert.throws(() => readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test", TELEGRAM_SCAN_EXPORT_FILE: "bad.txt" }), /\.json/);
  assert.throws(() => readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test", TELEGRAM_SCAN_DOWNLOAD_TIMEOUT_MS: "0" }), /TIMEOUT/);
  assert.equal(normalizedText(" ＡＢＣ\n  ９０斤\t"), "ABC 90斤");
});

test("dedup is text-only across the entire folder; video is skipped; uncaptioned images remain separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-collect-test-"));
  const originalFetch = globalThis.fetch;
  const downloaded: string[] = [];
  const historyRead: number[] = [];
  const histories: Record<number, Message[]> = {
    1: [message(9, "体重９０斤\n身高165", photo("first")), message(8, "不应出现", { type: "video" }),
      message(7, "", photo("empty-a")), message(6, "same image, different text", photo("first"))],
    2: [message(5, "体重90斤 身高165", photo("different-image")), message(4, "", photo("empty-b")),
      message(3, "文字独立保留"), message(2, "也应跳过", { type: "document", mimeType: "video/mp4" })],
  };
  const client = { iterHistory: (peer: { channelId: number }) => {
    historyRead.push(peer.channelId); return history(histories[peer.channelId]);
  }, downloadAsIterable: (id: string, params: { dcId?: number; fileSize?: number; abortSignal?: AbortSignal }) => (async function* () {
    assert.deepEqual(historyRead, [1, 2], "all channels must be deduplicated before image download");
    assert.equal(params.dcId, 5);
    assert.equal(params.fileSize, 3);
    assert.ok(params.abortSignal instanceof AbortSignal);
    downloaded.push(id); yield new Uint8Array([1, 2, 3]);
  })() } as unknown as TelegramClient;
  try {
    globalThis.fetch = async () => { throw new Error("scan must never call model APIs"); };
    await exportFolderContents(client, [channel(1), channel(2)], { ...readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test" }), exportFile: join(directory, "result.json") });
    const text = await readFile(join(directory, "result.json"), "utf8");
    const result = JSON.parse(text);
    assert.match(text, /\n  "records": \[/, "output is formatted JSON rather than JSONL");
    assert.equal(result.complete, true);
    assert.equal(result.stage, "collected");
    assert.equal(result.nextStep, "awaiting_user");
    assert.equal(result.stats.duplicatesRemoved, 1);
    assert.equal(result.stats.videosSkipped, 2);
    assert.equal(result.records.length, 5);
    assert.equal(result.records[0].sources.length, 2);
    assert.equal(result.records[0].images[0].base64, "AQID");
    assert.deepEqual(downloaded, ["first", "empty-a", "first", "empty-b"]);
    assert.equal(result.records.filter((record: { text: string }) => record.text === "").length, 2);
    assert.equal(result.records.some((record: { text: string }) => record.text.includes("应跳过") || record.text.includes("不应出现")), false);
    assert.equal("analysis" in result.records[0], false);
    assert.deepEqual(await readdir(directory), ["result.json"]);
  } finally { globalThis.fetch = originalFetch; await clean(directory); }
});

test("mixed albums combine text and keep static images, including image documents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-collect-test-"));
  const client = { iterHistory: () => history([message(3, "视频说明应被跳过", { type: "video" }, "album"),
    message(2, "90斤", { type: "document", fileId: "png", mimeType: "image/png", fileSize: 2 }, "album"),
    message(1, "165cm", photo("jpeg", 2), "album")]),
    downloadAsIterable: () => (async function* () { yield new Uint8Array([1, 2]); })() } as unknown as TelegramClient;
  try {
    await exportFolderContents(client, [channel(1)], { ...readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test" }), exportFile: join(directory, "result.json") });
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.equal(result.records[0].text, "165cm\n90斤");
    assert.deepEqual(result.records[0].images.map((image: { mimeType: string }) => image.mimeType), ["image/jpeg", "image/png"]);
    assert.deepEqual(result.records[0].sources[0].messageIds, [1, 2]);
    assert.equal(result.stats.videosSkipped, 1);
  } finally { await clean(directory); }
});

test("bounded image downloads and channel failures produce valid incomplete JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-collect-test-"));
  let chunks = 0;
  const client = { iterHistory: (peer: { channelId: number }) => (async function* () {
    if (peer.channelId === 2) throw new Error("CHANNEL_PRIVATE");
    yield message(1, "image", { ...photo("big"), fileSize: undefined });
  })(), downloadAsIterable: () => (async function* () {
    chunks += 1; yield new Uint8Array([1, 2]); chunks += 1; yield new Uint8Array([3, 4]);
    chunks += 1; yield new Uint8Array([5]);
  })() } as unknown as TelegramClient;
  try {
    await assert.rejects(exportFolderContents(client, [channel(1), channel(2)], {
      ...readExportOptions([], { TELEGRAM_SCAN_FOLDER: "test" }), maxImageBytes: 3, exportFile: join(directory, "result.json"),
    }), /complete=false/);
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.equal(result.complete, false);
    assert.equal(result.errors.length, 2);
    assert.equal(result.records[0].imageErrors.length, 1);
    assert.equal(chunks, 2, "download stops as soon as the configured size limit is exceeded");
    assert.deepEqual(await readdir(directory), ["result.json"]);
  } finally { await clean(directory); }
});
