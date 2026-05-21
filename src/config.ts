import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, OpenAiConfig, RuleConfig, RuleType } from "./types.js";

export const CONFIG_ENV = "TELEGRAM_FOLDER_RULES";
export const SNAPSHOT_ENV = "TELEGRAM_DIALOG_SNAPSHOT";
export const CLASSIFIED_ENV = "TELEGRAM_CLASSIFIED_OUTPUT";
export const UNFILED_ENV = "TELEGRAM_UNFILED_OUTPUT";
export const FOLDER_STATS_ENV = "TELEGRAM_FOLDER_STATS_OUTPUT";
export const FOLDER_OVERLAPS_ENV = "TELEGRAM_FOLDER_OVERLAPS_OUTPUT";

const DEFAULT_CONFIG_CANDIDATES = ["folder_rules.json", "telegram-folders.config.json"];

export function getSnapshotPath(): string {
  return resolve(process.cwd(), process.env[SNAPSHOT_ENV] ?? "dialogs_snapshot.json");
}

export function getClassifiedPath(): string {
  return resolve(process.cwd(), process.env[CLASSIFIED_ENV] ?? "classified_dialogs.json");
}

export function getUnfiledPath(): string {
  return resolve(process.cwd(), process.env[UNFILED_ENV] ?? "unfiled_dialogs.json");
}

export function getFolderStatsPath(): string {
  return resolve(process.cwd(), process.env[FOLDER_STATS_ENV] ?? "folder_stats.json");
}

export function getFolderOverlapsPath(): string {
  return resolve(process.cwd(), process.env[FOLDER_OVERLAPS_ENV] ?? "folder_overlaps.json");
}

export async function resolveConfigPath(): Promise<string> {
  const explicit = process.env[CONFIG_ENV];
  if (explicit) {
    return resolve(process.cwd(), explicit);
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const absolute = resolve(process.cwd(), candidate);
    try {
      await access(absolute, constants.F_OK);
      return absolute;
    } catch {
      // continue
    }
  }

  return resolve(process.cwd(), DEFAULT_CONFIG_CANDIDATES[0]);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRuleTypes(value: unknown): RuleType[] {
  const allowed = new Set<RuleType>(["private", "group", "supergroup", "channel", "bot"]);
  const source = Array.isArray(value) ? value : ["private", "group", "supergroup", "channel", "bot"];
  return source
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is RuleType => allowed.has(item as RuleType));
}

function normalizeRules(value: unknown): RuleConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules: RuleConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const data = item as Record<string, unknown>;
    const folder = toOptionalString(data.folder) ?? toOptionalString(data.title);
    const patterns = Array.isArray(data.patterns)
      ? data.patterns.map((pattern) => String(pattern).trim()).filter(Boolean)
      : [];

    if (!folder || patterns.length === 0) {
      continue;
    }

    rules.push({
      folder,
      patterns,
      types: normalizeRuleTypes(data.types),
    });
  }

  return rules;
}

function normalizeOpenAiConfig(root: Record<string, unknown>, rules: RuleConfig[]): OpenAiConfig {
  const source = (root.openai && typeof root.openai === "object" ? root.openai : {}) as Record<string, unknown>;
  const apiStyle = String(source.api_style ?? source.apiStyle ?? process.env.OPENAI_API_STYLE ?? "auto")
    .trim()
    .toLowerCase();

  return {
    baseUrl: String(source.base_url ?? source.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
    apiKey: toOptionalString(source.api_key ?? source.apiKey ?? process.env.OPENAI_API_KEY),
    model: String(source.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4"),
    batchSize: Number(source.batch_size ?? source.batchSize ?? 50),
    apiStyle: apiStyle === "chat" || apiStyle === "responses" ? apiStyle : "auto",
    maxRetries: Number(source.max_retries ?? source.maxRetries ?? 3),
    retryDelaySeconds: Number(source.retry_delay_seconds ?? source.retryDelaySeconds ?? 2),
    rules,
  };
}

function fromLegacyConfig(raw: Record<string, unknown>): AppConfig {
  const privateFolderTitle = toOptionalString((raw.privateFolder as Record<string, unknown> | undefined)?.title) ?? "私聊";
  const uncategorizedTitle = toOptionalString((raw.uncategorizedFolder as Record<string, unknown> | undefined)?.title) ?? "未分类";
  const groupRules = normalizeRules(raw.groupRules);
  const rules: RuleConfig[] = [
    { folder: privateFolderTitle, patterns: [".*"], types: normalizeRuleTypes(["private"]) },
    ...groupRules.map((rule) => ({
      folder: rule.folder,
      patterns: rule.patterns,
      types: rule.types.length ? rule.types : normalizeRuleTypes(["group", "supergroup", "channel", "bot"]),
    })),
    { folder: uncategorizedTitle, patterns: [".*"], types: normalizeRuleTypes(["group", "supergroup", "channel", "bot"]) },
  ];

  return {
    apiId: Number(raw.apiId),
    apiHash: String(raw.apiHash),
    phone: toOptionalString(raw.phone),
    password: toOptionalString(raw.password),
    botToken: toOptionalString(raw.botToken),
    sessionName: toOptionalString(raw.sessionStorage) ?? "telegram-automatic.session",
    dryRun: false,
    openai: normalizeOpenAiConfig(raw, rules),
  };
}

function fromPythonStyleConfig(raw: Record<string, unknown>): AppConfig {
  const rules = normalizeRules(raw.rules);

  return {
    apiId: Number(raw.api_id),
    apiHash: String(raw.api_hash),
    phone: toOptionalString(raw.phone),
    password: toOptionalString(raw.password),
    botToken: toOptionalString(raw.bot_token),
    sessionName: toOptionalString(raw.session_name) ?? "telegram-auto",
    dryRun: Boolean(raw.dry_run),
    openai: normalizeOpenAiConfig(raw, rules),
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const path = await resolveConfigPath();
  const rawText = await readFile(path, "utf8");
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  const config = "api_id" in parsed || "api_hash" in parsed ? fromPythonStyleConfig(parsed) : fromLegacyConfig(parsed);

  if (!Number.isFinite(config.apiId) || config.apiId <= 0) {
    throw new Error(`配置中的 api_id/apiId 无效: ${path}`);
  }
  if (!config.apiHash) {
    throw new Error(`配置中的 api_hash/apiHash 不能为空: ${path}`);
  }

  return config;
}
