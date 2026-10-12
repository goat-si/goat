import type { EnvironmentId, ThreadId } from "@goat/contracts";

import type { DraftId } from "./composerDraftStore";
import type { GlobalAgentRef } from "./globalAgentStore";
import type { ThreadRouteTarget } from "./threadRoutes";

export const GLOBAL_AGENT_TITLE = "Global agent";

/** GOAT Bot's entry route. */
export const GOAT_BOT_PATH = "/bot";

type GoatBotThreadRef = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function isGlobalAgentThread(
  thread: { readonly environmentId: string; readonly id: string },
  ref: GlobalAgentRef | null,
): boolean {
  return ref !== null && thread.environmentId === ref.environmentId && thread.id === ref.threadId;
}

/** Both the global agent and GOAT Bot have their own entry points, so thread lists leave them out. */
export function excludeGlobalAgentThreads<
  T extends { readonly environmentId: string; readonly id: string },
>(threads: readonly T[], ref: GlobalAgentRef | null, botRef: GoatBotThreadRef | null = null): T[] {
  return threads.filter(
    (thread) => !isGlobalAgentThread(thread, ref) && !isGoatBotThread(thread, botRef),
  );
}

/**
 * True on the global draft and thread routes. "/" is never active: it is a
 * transient route that immediately replaces itself with the resolved target
 * (the global agent, or a project draft when it falls back).
 */
export function isGlobalAgentRoute(
  pathname: string,
  target: ThreadRouteTarget | null,
  ref: GlobalAgentRef | null,
): boolean {
  if (ref === null || pathname === "/" || target === null) return false;
  if (target.kind === "draft") return target.draftId === ref.draftId;
  return (
    target.threadRef.environmentId === ref.environmentId &&
    target.threadRef.threadId === ref.threadId
  );
}

/** Where the old global agent opens in its coding view, or null when nothing is left to open. */
export type GlobalAgentLegacyRoute =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "draft"; readonly draftId: DraftId };

export function legacyGlobalAgentRoute(
  ref: GlobalAgentRef | null,
  shell: {
    readonly archivedAt: string | null;
    readonly deletedAt?: string | null | undefined;
  } | null,
  draftUnpromoted: boolean,
): GlobalAgentLegacyRoute | null {
  if (ref === null) return null;
  if (shell !== null && shell.archivedAt === null && shell.deletedAt == null) {
    return { kind: "thread", environmentId: ref.environmentId, threadId: ref.threadId };
  }
  if (shell === null && draftUnpromoted) return { kind: "draft", draftId: ref.draftId };
  return null;
}

/** True for the server's GOAT Bot thread. */
export function isGoatBotThread(
  thread: { readonly environmentId: string; readonly id: string },
  botRef: GoatBotThreadRef | null,
): boolean {
  return (
    botRef !== null &&
    thread.environmentId === botRef.environmentId &&
    thread.id === botRef.threadId
  );
}

/** True on /bot and on the bot thread's own route. */
export function isGoatBotRoute(
  pathname: string,
  target: ThreadRouteTarget | null,
  botRef: GoatBotThreadRef | null,
): boolean {
  if (pathname === GOAT_BOT_PATH) return true;
  if (botRef === null || target === null || target.kind !== "server") return false;
  return (
    target.threadRef.environmentId === botRef.environmentId &&
    target.threadRef.threadId === botRef.threadId
  );
}

/** The logo and bot row use the same feature predicate supplied by the channel session. */
export function globalAgentLogoTarget(goatBotEnabled: boolean) {
  return goatBotEnabled
    ? ({ to: GOAT_BOT_PATH, label: "Open GOAT Bot" } as const)
    : ({ to: "/", label: "Open global agent" } as const);
}
