import {
  SCREEN_TARGET_CONTRACT_VERSION,
  screenTargetApi,
  type ScreenRunResult,
} from "@goat/contracts";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

/** The API bundle a result carries, when the thread lacks this version or a surface it now has. */
export const makeScreenApiTeacher = () => {
  // What each thread was last given of the cell API; the oldest thread drops out first.
  const taught = new Map<
    string,
    { version: string; session: string; app: boolean; tab: boolean }
  >();
  return (
    invocation: McpThreadInvocationScope,
    availability: ScreenRunResult["availability"],
    reset: boolean,
  ): string | undefined => {
    const threadId = invocation.thread.threadId;
    const has = (kind: "app" | "tab") =>
      availability.some((surface) => surface.kind === kind && surface.available);
    const now = { app: has("app"), tab: has("tab") };
    const before = taught.get(threadId);
    const session = invocation.thread.providerSessionId;
    if (
      !reset &&
      before !== undefined &&
      before.version === SCREEN_TARGET_CONTRACT_VERSION &&
      before.session === session &&
      (before.app || !now.app) &&
      (before.tab || !now.tab)
    )
      return undefined;
    // The bundle names what the turn has now; the record keeps what this session was already given.
    const given =
      before !== undefined &&
      before.session === session &&
      before.version === SCREEN_TARGET_CONTRACT_VERSION;
    taught.delete(threadId);
    taught.set(threadId, {
      version: SCREEN_TARGET_CONTRACT_VERSION,
      session,
      app: now.app || (given && !reset && before?.app === true),
      tab: now.tab || (given && !reset && before?.tab === true),
    });
    if (taught.size > 1024) {
      const oldest = taught.keys().next().value;
      if (oldest !== undefined) taught.delete(oldest);
    }
    return screenTargetApi(now);
  };
};
