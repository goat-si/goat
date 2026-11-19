import * as Effect from "effect/Effect";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeAgentSdkQueryRunner.ts";

const CLAUDE_RENAME_TIMEOUT = "10 seconds";

export interface ClaudeSessionTitleState {
  appliedTitle: string | undefined;
  pendingTitle: string | undefined;
}

export const applyClaudeSessionTitle = Effect.fn("ClaudeSessionTitles.apply")(function* (
  state: ClaudeSessionTitleState,
  query: ClaudeAgentSdkQuerySession,
  title: string,
) {
  if (state.appliedTitle === title) return false;
  if (query.renameSession === undefined) {
    yield* Effect.logWarning("Claude session rename is unavailable.");
    return false;
  }
  state.pendingTitle = title;
  const success = yield* query
    .renameSession(title)
    .pipe(Effect.timeout(CLAUDE_RENAME_TIMEOUT), Effect.isSuccess);
  if (state.pendingTitle === title) state.pendingTitle = undefined;
  if (!success) {
    yield* Effect.logWarning("Claude session rename failed.");
    return false;
  }
  state.appliedTitle = title;
  return true;
});

export function claudeReportedSessionTitle(message: unknown): string | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "system" ||
    Reflect.get(message, "subtype") !== "session_title_changed"
  )
    return undefined;
  const title: unknown = Reflect.get(message, "title");
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined;
}
