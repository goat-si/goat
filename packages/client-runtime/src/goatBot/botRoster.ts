import { MAIN_BOT_ID, type BotProfile } from "@goat/contracts";

export type BotRosterEntry =
  | { readonly kind: "main"; readonly profile: BotProfile | null }
  | { readonly kind: "member"; readonly profile: BotProfile };

/** Keep a main entry even before a server has created its profile. */
export function botRoster({
  supportsProfiles,
  bots,
}: {
  supportsProfiles: boolean;
  bots: ReadonlyArray<BotProfile> | undefined;
}): ReadonlyArray<BotRosterEntry> {
  if (!supportsProfiles || bots === undefined) return [{ kind: "main", profile: null }];
  const main = bots.find((bot) => bot.role === "main" || bot.botId === MAIN_BOT_ID) ?? null;
  return [
    { kind: "main", profile: main },
    ...bots
      .filter((bot) => bot.role !== "main" && bot.botId !== MAIN_BOT_ID)
      .map((profile) => ({ kind: "member" as const, profile })),
  ];
}
