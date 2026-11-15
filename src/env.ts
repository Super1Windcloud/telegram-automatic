import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as util from "node:util";

export function loadEnvironment(path = resolve(".env"), environment: NodeJS.ProcessEnv = process.env): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (typeof util.parseEnv !== "function") throw new Error("加载 .env 需要 Node.js 20.12 或更新版本。");
  for (const [key, value] of Object.entries(util.parseEnv(content))) {
    if (environment[key] === undefined) environment[key] = value;
  }
}
