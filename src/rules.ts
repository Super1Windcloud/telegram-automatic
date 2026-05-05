import type { ClassifiedResult, DialogRecord, RuleConfig, RuleType } from "./types.js";

export function groupByCategory(items: ClassifiedResult[]): Record<string, ClassifiedResult[]> {
  return Object.fromEntries(
    Object.entries(
      items.reduce<Record<string, ClassifiedResult[]>>((acc, item) => {
        const key = item.category.trim() || "未分类";
        acc[key] ??= [];
        acc[key].push(item);
        return acc;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right, "zh-CN")),
  );
}

export function classifyByRules(
  dialogs: DialogRecord[],
  rules: RuleConfig[],
): Array<Pick<ClassifiedResult, "id" | "category" | "summary">> {
  return dialogs.map((dialog) => {
    const searchText = [dialog.title, dialog.username ?? "", dialog.description].join(" ");
    const kinds = new Set<RuleType>(dialog.types);

    for (const rule of rules) {
      if (!rule.types.some((type) => kinds.has(type))) {
        continue;
      }

      if (rule.patterns.some((pattern) => new RegExp(pattern, "i").test(searchText))) {
        return { id: dialog.id, category: rule.folder, summary: "命中本地规则" };
      }
    }

    if (kinds.has("bot")) {
      return { id: dialog.id, category: "工具机器人", summary: "按会话类型判定" };
    }
    if (kinds.has("channel")) {
      return { id: dialog.id, category: "资讯", summary: "按频道类型判定" };
    }
    if (kinds.has("group") || kinds.has("supergroup")) {
      return { id: dialog.id, category: "社群", summary: "按群组类型判定" };
    }
    if (kinds.has("private")) {
      return { id: dialog.id, category: "私聊", summary: "按私聊类型判定" };
    }

    return { id: dialog.id, category: "未分类", summary: "本地兜底分类" };
  });
}
