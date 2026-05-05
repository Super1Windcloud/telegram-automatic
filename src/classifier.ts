import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { classifyByRules, groupByCategory } from "./rules.js";
import type { AppConfig, ClassificationPayload, ClassifiedResult, DialogRecord } from "./types.js";

const SYSTEM_PROMPT = `你是 Telegram 会话分类助手。
你只需要对群组和频道类会话做内容分类。
机器人和私聊不会交给你分类，外部程序会单独处理。
你会基于会话标题、用户名、类型和简介，为每个会话输出一个分类结果。

要求：
1. 输出必须是 JSON 对象，且只输出 JSON。
2. JSON 格式为：
{
  "results": [
    {
      "id": 123,
      "category": "分类名",
      "summary": "一句话说明"
    }
  ]
}
3. category 使用简洁中文，优先稳定、通用，例如：资讯、学习、开发、交易、娱乐、本地群、资源、未分类。
4. summary 控制在 30 字以内。
5. 不要遗漏任何输入 id。
6. 本次输出允许使用的 category 总数最多 10 个，必须尽量复用已有分类，不要为少量样本新建细分类。
7. 如果某个会话可以归入多个近义分类，优先合并到更通用的大类，避免产生碎片化分类。`;

const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildChatEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

function buildResponsesEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized.endsWith("/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/v1/responses`;
}

function buildUserPrompt(dialogs: DialogRecord[]): string {
  return JSON.stringify({
    dialogs: dialogs.map((dialog) => ({
      id: dialog.id,
      title: dialog.title,
      username: dialog.username,
      types: dialog.types,
      description: dialog.description,
    })),
  });
}

function splitDialogsByType(dialogs: DialogRecord[]): {
  forcedResults: Array<Pick<ClassifiedResult, "id" | "category" | "summary">>;
  modelDialogs: DialogRecord[];
} {
  const forcedResults: Array<Pick<ClassifiedResult, "id" | "category" | "summary">> = [];
  const modelDialogs: DialogRecord[] = [];

  for (const dialog of dialogs) {
    if (dialog.types.includes("bot")) {
      forcedResults.push({ id: dialog.id, category: "工具机器人", summary: "按机器人类型归组" });
      continue;
    }
    if (dialog.types.includes("private")) {
      forcedResults.push({ id: dialog.id, category: "私聊", summary: "按私聊类型归组" });
      continue;
    }
    modelDialogs.push(dialog);
  }

  return { forcedResults, modelDialogs };
}

function extractJsonObject(text: string): string {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split(/\r?\n/);
    if (lines.length >= 3) {
      stripped = lines.slice(1, -1).join("\n").trim();
    }
  }

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`模型返回中未找到 JSON 对象: ${text}`);
  }
  return stripped.slice(start, end + 1);
}

async function requestJson(endpoint: string, apiKey: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}; ${text}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  return JSON.parse(text);
}

function parseChatResponse(raw: any): Array<Pick<ClassifiedResult, "id" | "category" | "summary">> {
  let content = raw?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((item) => item && typeof item === "object" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`OpenAI chat/completions 返回内容无法解析: ${JSON.stringify(raw)}`);
  }
  const parsed = JSON.parse(extractJsonObject(content));
  if (!Array.isArray(parsed.results)) {
    throw new Error(`OpenAI 返回 results 格式错误: ${JSON.stringify(parsed)}`);
  }
  return parsed.results;
}

function parseResponsesResponse(raw: any): Array<Pick<ClassifiedResult, "id" | "category" | "summary">> {
  const texts: string[] = [];
  for (const item of raw?.output ?? []) {
    for (const content of item?.content ?? []) {
      if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  const outputText = texts.join("") || raw?.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error(`OpenAI responses 返回内容无法解析: ${JSON.stringify(raw)}`);
  }

  const parsed = JSON.parse(extractJsonObject(outputText));
  if (!Array.isArray(parsed.results)) {
    throw new Error(`OpenAI 返回 results 格式错误: ${JSON.stringify(parsed)}`);
  }
  return parsed.results;
}

async function callApi(params: {
  style: "chat" | "responses";
  strictJson: boolean;
  endpoint: string;
  apiKey: string;
  model: string;
  dialogs: DialogRecord[];
}): Promise<Array<Pick<ClassifiedResult, "id" | "category" | "summary">>> {
  if (params.style === "chat") {
    const payload: Record<string, unknown> = {
      model: params.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(params.dialogs) },
      ],
    };
    if (params.strictJson) {
      payload.response_format = { type: "json_object" };
    }
    return parseChatResponse(await requestJson(params.endpoint, params.apiKey, payload));
  }

  const payload: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(params.dialogs) },
    ],
  };
  if (params.strictJson) {
    payload.text = { format: { type: "json_object" } };
  }
  return parseResponsesResponse(await requestJson(params.endpoint, params.apiKey, payload));
}

function isRetryableError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  return RETRYABLE_HTTP_CODES.has(status);
}

async function callWithRetry(
  config: AppConfig["openai"],
  dialogs: DialogRecord[],
): Promise<Array<Pick<ClassifiedResult, "id" | "category" | "summary">>> {
  const styles: Array<"chat" | "responses"> = config.apiStyle === "responses"
    ? ["responses", "chat"]
    : config.apiStyle === "chat"
      ? ["chat", "responses"]
      : ["chat", "responses"];

  let lastError: unknown;
  for (const style of styles) {
    const endpoint = style === "chat" ? buildChatEndpoint(config.baseUrl) : buildResponsesEndpoint(config.baseUrl);

    for (const strictJson of [true, false]) {
      for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
        try {
          console.log(
            `[请求] style=${style}; strict_json=${strictJson}; batch_size=${dialogs.length}; attempt=${attempt}/${config.maxRetries}; endpoint=${endpoint}`,
          );
          return await callApi({
            style,
            strictJson,
            endpoint,
            apiKey: config.apiKey!,
            model: config.model,
            dialogs,
          });
        } catch (error) {
          lastError = error;
          if (attempt < config.maxRetries && isRetryableError(error)) {
            console.log(`[重试] ${String(error)}`);
            await sleep(config.retryDelaySeconds * attempt * 1000);
            continue;
          }
          break;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function classifyBatch(
  config: AppConfig["openai"],
  dialogs: DialogRecord[],
): Promise<Array<Pick<ClassifiedResult, "id" | "category" | "summary">>> {
  try {
    return await callWithRetry(config, dialogs);
  } catch (error) {
    const message = String(error);
    const parseError = message.includes("返回内容无法解析") || message.includes("未找到 JSON 对象");
    if (dialogs.length <= 1 || !isRetryableError(error)) {
      if (parseError) {
        console.log(`[降级] batch_size=${dialogs.length}; 使用本地规则分类。error=${message}`);
        return classifyByRules(dialogs, config.rules);
      }
      console.log(`[终止] batch_size=${dialogs.length}; error=${message}`);
      throw error;
    }

    const splitAt = Math.floor(dialogs.length / 2);
    const left = dialogs.slice(0, splitAt);
    const right = dialogs.slice(splitAt);
    console.log(`批次大小 ${dialogs.length} 请求失败，自动拆分为 ${left.length} + ${right.length} 后重试。`);
    return [...(await classifyBatch(config, left)), ...(await classifyBatch(config, right))];
  }
}

export async function classifySnapshot(dialogs: DialogRecord[], config: AppConfig): Promise<ClassificationPayload> {
  if (!config.openai.apiKey) {
    throw new Error("缺少 openai.api_key 或环境变量 OPENAI_API_KEY。");
  }

  const { forcedResults, modelDialogs } = splitDialogsByType(dialogs);
  if (forcedResults.length) {
    console.log(`按类型直接归组: ${forcedResults.length} 个会话`);
  }

  const allResults = [...forcedResults];
  for (let start = 0; start < modelDialogs.length; start += config.openai.batchSize) {
    const batch = modelDialogs.slice(start, start + config.openai.batchSize);
    console.log(`分类批次 ${Math.floor(start / config.openai.batchSize) + 1}: ${start + 1}-${start + batch.length} / ${modelDialogs.length}`);
    allResults.push(...(await classifyBatch(config.openai, batch)));
  }

  const byId = new Map(dialogs.map((dialog) => [dialog.id, dialog]));
  const mergedResults: ClassifiedResult[] = [];
  for (const result of allResults) {
    const dialog = byId.get(result.id);
    if (!dialog) {
      continue;
    }
    mergedResults.push({
      ...dialog,
      category: result.category || "未分类",
      summary: result.summary || "",
    });
  }

  return {
    total: mergedResults.length,
    model: config.openai.model,
    apiStyle: config.openai.apiStyle,
    groups: groupByCategory(mergedResults),
    results: mergedResults,
  };
}

export async function writeClassification(path: string, payload: ClassificationPayload): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readClassification(path: string): Promise<ClassificationPayload> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) {
    throw new Error("classified_dialogs.json 格式错误，缺少 results 列表。");
  }

  return parsed as ClassificationPayload;
}

export async function classificationExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
