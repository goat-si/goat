import {
  type BotProfile,
  type ChannelBotRef,
  ChannelGatewayError,
  MAIN_BOT_ID,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export type BotRosterEntry =
  | { readonly kind: "main"; readonly profile: BotProfile | null }
  | { readonly kind: "member"; readonly profile: BotProfile };

const isMain = (bot: BotProfile) => bot.role === "main" || bot.botId === MAIN_BOT_ID;
const byCreation = (a: BotProfile, b: BotProfile) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;

/** Main, then shown members, hidden members and deleted members, each oldest first. */
export function botRosterGroups(bots: ReadonlyArray<BotProfile>): {
  readonly main: BotProfile | null;
  readonly members: ReadonlyArray<BotProfile>;
  readonly hidden: ReadonlyArray<BotProfile>;
  readonly deleted: ReadonlyArray<BotProfile>;
} {
  const others = bots.filter((bot) => !isMain(bot)).sort(byCreation);
  return {
    main: bots.find(isMain) ?? null,
    members: others.filter((bot) => bot.state !== "deleted" && bot.hidden !== true),
    hidden: others.filter((bot) => bot.state !== "deleted" && bot.hidden === true),
    deleted: others.filter((bot) => bot.state === "deleted"),
  };
}

/** Main and the members a person keeps shown. Keeps a main entry before a server has created its profile. */
export function botRoster({
  supportsProfiles,
  bots,
}: {
  supportsProfiles: boolean;
  bots: ReadonlyArray<BotProfile> | undefined;
}): ReadonlyArray<BotRosterEntry> {
  if (!supportsProfiles || bots === undefined) return [{ kind: "main", profile: null }];
  const groups = botRosterGroups(bots);
  return [
    { kind: "main", profile: groups.main },
    ...groups.members.map((profile) => ({ kind: "member" as const, profile })),
  ];
}

/** The member whose conversation is this thread, in any state. */
export function findMemberBot(
  bots: ReadonlyArray<BotProfile> | undefined,
  environmentId: string,
  threadId: string,
): BotProfile | null {
  return (
    bots?.find(
      (bot) =>
        !isMain(bot) && bot.environmentId === environmentId && bot.sessionThreadId === threadId,
    ) ?? null
  );
}

/** Where a member's messages go: its own conversation, in the main bot's project. */
export function memberBotRef(profile: BotProfile, main: ChannelBotRef): ChannelBotRef {
  return {
    environmentId: profile.environmentId,
    projectId: main.projectId,
    threadId: profile.sessionThreadId,
  };
}

const isGatewayError = Schema.is(ChannelGatewayError);

/** What to tell a person when creating, hiding, deleting or restoring a bot failed. */
export function botManageFailure(error: unknown): string {
  if (isGatewayError(error) && error.reason === "bot_busy") return "Stop its open tasks first.";
  if (error instanceof Error && error.message !== "") return error.message;
  return "Please try again.";
}
