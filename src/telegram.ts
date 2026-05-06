import { TelegramClient, type Dialog, type Peer, type tl } from "@mtcute/node";
import type { AppConfig, DialogInfo, RuleType } from "./types.js";

export type CollectedDialog = {
  dialog: Dialog;
  info: DialogInfo;
};

function buildDialogTypes(peer: Peer): RuleType[] {
  if (peer.type === "user") {
    return peer.isBot ? ["private", "bot"] : ["private"];
  }

  switch (peer.chatType) {
    case "group":
      return ["group"];
    case "supergroup":
    case "gigagroup":
    case "monoforum":
      return ["group", "supergroup"];
    case "channel":
      return ["channel"];
    default:
      return [];
  }
}

function buildDialogDescription(dialog: Dialog, peer: Peer, types: RuleType[]): string {
  return [
    `title=${peer.displayName}`,
    `types=${types.join(",") || "unknown"}`,
    `username=${peer.username ?? ""}`,
    `unread=${dialog.unreadCount}`,
    `archived=${dialog.isArchived}`,
    `pinned=${dialog.isPinned}`,
  ].join("; ");
}

export function createTelegramClient(config: AppConfig): TelegramClient {
  return new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: config.sessionName,
    disableUpdates: true,
  });
}

export async function startTelegramClient(client: TelegramClient, config: AppConfig): Promise<void> {
  await client.start({
    phone: config.phone ? async () => config.phone! : undefined,
    botToken: config.botToken ? async () => config.botToken! : undefined,
    password: config.password ? async () => config.password! : undefined,
    code: () => client.input("请输入 Telegram 登录验证码: "),
    invalidCodeCallback: async (type) => {
      console.log(`${type === "code" ? "验证码" : "两步验证密码"}错误，请重新输入。`);
    },
    codeSentCallback: async (sentCode) => {
      console.log(`验证码已发送，方式: ${sentCode.type}`);
    },
  });
}

export async function collectDialogs(client: TelegramClient): Promise<DialogInfo[]> {
  const collected = await collectDialogsWithState(client);
  return collected.map((item) => item.info);
}

export async function collectDialogsWithState(client: TelegramClient): Promise<CollectedDialog[]> {
  const dialogs: CollectedDialog[] = [];

  for await (const dialog of client.iterDialogs({ pinned: "keep", archived: "keep" })) {
    const peer = dialog.peer;
    const inputPeer = peer.inputPeer;
    if (inputPeer._ === "inputPeerEmpty") {
      continue;
    }

    const types = buildDialogTypes(peer);
    dialogs.push({
      dialog,
      info: {
        id: peer.id,
        title: peer.displayName,
        username: peer.username,
        types,
        description: buildDialogDescription(dialog, peer, types),
        inputPeer,
      },
    });
  }

  return dialogs.sort((left, right) => {
    const byTitle = left.info.title.localeCompare(right.info.title, "zh-CN");
    return byTitle !== 0 ? byTitle : left.info.id - right.info.id;
  });
}

export function inputPeerKey(peer: tl.TypeInputPeer): string {
  switch (peer._) {
    case "inputPeerSelf":
    case "inputPeerEmpty":
      return peer._;
    case "inputPeerChat":
      return `${peer._}:${peer.chatId}`;
    case "inputPeerChannel":
      return `${peer._}:${peer.channelId}`;
    case "inputPeerUser":
      return `${peer._}:${peer.userId}`;
    case "inputPeerUserFromMessage":
      return `${peer._}:${peer.userId}:${peer.msgId}`;
    case "inputPeerChannelFromMessage":
      return `${peer._}:${peer.channelId}:${peer.msgId}`;
    default:
      return JSON.stringify(peer);
  }
}

export function dedupeInputPeers(peers: tl.TypeInputPeer[]): tl.TypeInputPeer[] {
  const seen = new Set<string>();
  const result: tl.TypeInputPeer[] = [];

  for (const peer of peers) {
    if (peer._ === "inputPeerEmpty") {
      continue;
    }

    const key = inputPeerKey(peer);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(peer);
  }

  return result;
}
