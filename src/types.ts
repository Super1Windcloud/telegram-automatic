import type { tl } from "@mtcute/node";

export type RuleType = "private" | "group" | "supergroup" | "channel" | "bot";

export type RuleConfig = {
  folder: string;
  patterns: string[];
  types: RuleType[];
};

export type OpenAiConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  batchSize: number;
  apiStyle: "auto" | "chat" | "responses";
  maxRetries: number;
  retryDelaySeconds: number;
  rules: RuleConfig[];
};

export type AppConfig = {
  apiId: number;
  apiHash: string;
  phone?: string;
  password?: string;
  botToken?: string;
  sessionName: string;
  dryRun: boolean;
  openai: OpenAiConfig;
};

export type DialogRecord = {
  id: number;
  title: string;
  username: string | null;
  types: RuleType[];
  description: string;
};

export type DialogInfo = DialogRecord & {
  inputPeer: tl.TypeInputPeer;
};

export type ClassifiedResult = DialogRecord & {
  category: string;
  summary: string;
};

export type ClassificationPayload = {
  total: number;
  model: string;
  apiStyle: string;
  groups: Record<string, ClassifiedResult[]>;
  results: ClassifiedResult[];
};
