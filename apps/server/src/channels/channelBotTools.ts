import type { BotProfile } from "@goat/contracts";

type Tools = BotProfile["tools"];

export function botToolsNarrowed(previous: Tools, next: Tools): boolean {
  return (["mcpServers", "skills"] as const).some((key) => {
    const before = previous?.[key] ?? "all";
    const after = next?.[key] ?? "all";
    return after !== "all" && (before === "all" || before.some((id) => !after.includes(id)));
  });
}

export function botToolsRefusal(
  bot: { readonly name: string; readonly tools?: Tools },
  destination: string,
): string | undefined {
  if (!botToolsNarrowed(undefined, bot.tools)) return;
  return `${bot.name}'s tool limits can't be applied on ${destination}.`;
}
