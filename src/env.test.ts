import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "./env.js";

test(".env parses quoted Chinese values and comments without overriding shell variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-env-test-"));
  const path = join(directory, ".env");
  try {
    await writeFile(path, '# example\nTELEGRAM_SCAN_FOLDER="测试文件夹"\nTELEGRAM_SCAN_BELOW_JIN=90 # strict\nEXISTING=file\nEMPTY=file\n');
    const environment: NodeJS.ProcessEnv = { EXISTING: "shell", EMPTY: "" };
    loadEnvironment(path, environment);
    assert.equal(environment.TELEGRAM_SCAN_FOLDER, "测试文件夹");
    assert.equal(environment.TELEGRAM_SCAN_BELOW_JIN, "90");
    assert.equal(environment.EXISTING, "shell");
    assert.equal(environment.EMPTY, "");
    loadEnvironment(path, environment);
    assert.equal(environment.EXISTING, "shell");
    assert.doesNotThrow(() => loadEnvironment(join(directory, "absent.env"), environment));
    assert.throws(() => loadEnvironment(directory, environment));
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});
