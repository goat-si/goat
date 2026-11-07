import type { BotProfile, EnvironmentId } from "@goat/contracts";

// Conversation threads of active member bots, per environment. The send queue reads it at dispatch
// time; the roster and an open member screen write it. Kept apart so the roster needs no session code.
const active = new Map<EnvironmentId, ReadonlySet<string>>();

/** The roster's active members become the only ones whose messages may send. */
export function syncMobileGoatBotMembers(
  environmentId: EnvironmentId,
  bots: ReadonlyArray<BotProfile>,
): void {
  active.set(
    environmentId,
    new Set(
      bots
        .filter(
          (bot) =>
            bot.role === "member" && bot.state !== "deleted" && bot.environmentId === environmentId,
        )
        .map((bot) => bot.sessionThreadId),
    ),
  );
}

/** An open member screen's own view of whether its bot is active. */
export function markMobileGoatBotMember(
  environmentId: EnvironmentId,
  threadId: string,
  isActive: boolean,
): void {
  const next = new Set(active.get(environmentId));
  if (isActive) next.add(threadId);
  else next.delete(threadId);
  active.set(environmentId, next);
}

export function mobileGoatBotMemberActive(environmentId: EnvironmentId, threadId: string): boolean {
  return active.get(environmentId)?.has(threadId) === true;
}
