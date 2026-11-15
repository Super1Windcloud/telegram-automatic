import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import type { TelegramClient } from "@mtcute/node";
import type { CollectedDialog } from "./telegram.js";
import { collectMessageStats, readMessageStatsOptions } from "./message-stats.js";

function channel(id: number): CollectedDialog {
  return { info: { id, title: `channel-${id}`, username: null, inputPeer: { channelId: id } } } as unknown as CollectedDialog;
}

test("sums server history totals rather than latest message IDs or fetched page lengths", async () => {
  const calls: number[] = [];
  const totals: Record<number, number> = { 1: 855, 2: 426, 3: 0 };
  const client = { getHistory: async (peer: { channelId: number }, params: unknown) => {
    assert.deepEqual(params, { limit: 1 });
    calls.push(peer.channelId);
    return Object.assign(totals[peer.channelId] ? [{ id: 242000 }] : [], { total: totals[peer.channelId] });
  } } as unknown as Pick<TelegramClient, "getHistory">;
  const report = await collectMessageStats(client, [channel(1), channel(2), channel(3)], "test");
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(report.complete, true);
  assert.equal(report.totalMessages, 1281);
  assert.equal(report.successfulChannels, 3);
  assert.equal(report.failedChannels, 0);
  assert.deepEqual(report.results.map((row) => row.messageCount), [855, 426, 0]);
  assert.ok(report.results.every((row) => !Number.isNaN(Date.parse(row.queriedAt))));
});

test("failed and invalid counts remain null and do not prevent other channels from being counted", async () => {
  const client = { getHistory: async (peer: { channelId: number }) => {
    if (peer.channelId === 1) throw new Error("CHANNEL_PRIVATE");
    return Object.assign([], { total: peer.channelId === 2 ? Number.NaN : 30 });
  } } as unknown as Pick<TelegramClient, "getHistory">;
  const report = await collectMessageStats(client, [channel(1), channel(2), channel(3)], "test");
  assert.equal(report.complete, false);
  assert.equal(report.totalMessages, null);
  assert.equal(report.knownTotalMessages, 30);
  assert.equal(report.failedChannels, 2);
  assert.deepEqual(report.results.map((row) => row.messageCount), [null, null, 30]);
  assert.equal(report.results[0].error, "CHANNEL_PRIVATE");
});

test("empty folders have zero messages and need no history calls", async () => {
  const client = { getHistory: async () => { throw new Error("must not be called"); } } as unknown as Pick<TelegramClient, "getHistory">;
  const report = await collectMessageStats(client, [], "empty");
  assert.equal(report.complete, true);
  assert.equal(report.totalMessages, 0);
});

test("options use scan folder and configurable output but ignore scan ranges", () => {
  const defaults = readMessageStatsOptions([], { TELEGRAM_SCAN_FOLDER: "test", TELEGRAM_SCAN_OUTPUT: "output",
    TELEGRAM_SCAN_LIMIT: "1", TELEGRAM_SCAN_SINCE: "invalid", TELEGRAM_SCAN_IMAGE_MAX_MIB: "invalid" });
  assert.equal(defaults.folder, "test");
  assert.equal(defaults.output, resolve("output/message-stats.json"));
  const custom = readMessageStatsOptions(["--folder", "other", "--output", "custom.json"], {
    TELEGRAM_SCAN_FOLDER: "test", TELEGRAM_MESSAGE_STATS_OUTPUT: "env.json",
  });
  assert.equal(custom.folder, "other");
  assert.equal(custom.output, resolve("custom.json"));
  assert.equal(readMessageStatsOptions(["--help"], {}).help, true);
  for (const args of [[], ["--folder"], ["--limit", "10"], ["--folder", "test", "--output", "bad.txt"]]) {
    assert.throws(() => readMessageStatsOptions(args, {}));
  }
});
