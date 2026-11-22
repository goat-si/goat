import * as Effect from "effect/Effect";
import type { ChannelBotProfiles } from "./ChannelBotProfiles.ts";
import type { ChannelStoredTask } from "./ChannelLedger.ts";
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

export const remoteBotToolsRefusal = (
  profiles: ChannelBotProfiles["Service"],
  task: Pick<ChannelStoredTask, "ownerId" | "botId">,
  host: string,
) =>
  profiles.identity(task.ownerId, task.botId).pipe(
    Effect.match({
      onFailure: () => "Could not read the bot profile.",
      onSuccess: (profile) => botToolsRefusal(profile, host),
    }),
  );
