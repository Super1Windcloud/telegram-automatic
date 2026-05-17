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
  entityKind?: "user" | "bot" | "group" | "supergroup" | "channel" | "unknown";
  isDeleted?: boolean;
  peerType?: string;
  chatType?: string | null;
  inputPeerType?: string;
  hasPublicUsername?: boolean;
  normalizedId?: number;
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

export type UnfiledDialogsPayload = {
  totalDialogs: number;
  customFolderCount: number;
  customFolderTitles: string[];
  unfiledCount: number;
  results: DialogRecord[];
};

export type FolderStat = {
  type: string;
  id: number | null;
  title: string;
  dialogCount: number;
  includedPeerCount: number;
  pinnedPeerCount: number;
  excludePeerCount: number;
  flags: {
    contacts: boolean | null;
    nonContacts: boolean | null;
    groups: boolean | null;
    broadcasts: boolean | null;
    bots: boolean | null;
    excludeMuted: boolean | null;
    excludeRead: boolean | null;
    excludeArchived: boolean | null;
  };
};

export type FolderStatsPayload = {
  totalFolders: number;
  totalDialogs: number;
  customFolderFiledDialogsUniqueCount: number;
  unfiledDialogsCount: number;
  results: FolderStat[];
};
