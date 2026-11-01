import { isGoatBotSessionThreadId, type RunId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { goatBotSessionSharingFor } from "../channels/channelIds.ts";

export const sessionNativeSubagentLimit = (threadId: ThreadId) =>
  isGoatBotSessionThreadId(threadId) ? 0 : undefined;

/** The adapter's driver, or undefined when the instance is not registered. */
export const driverOf = <D, E, R>(adapter: Effect.Effect<{ readonly driver: D }, E, R>) =>
  adapter.pipe(
    Effect.map((found) => found.driver),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * The MCP credential scope of one provider turn. A GOAT Bot session on a per-run driver gets a
 * credential per run, so a delayed tool call still names the run that made it.
 */
export const sessionRunScope = (
  threadId: ThreadId,
  driver: string | undefined,
  runId: RunId | undefined,
) => {
  const perRun =
    isGoatBotSessionThreadId(threadId) && goatBotSessionSharingFor(driver) === "per_run";
  return {
    /** Whether a credential issued for `credentialRun` may serve this turn. */
    serves: (credentialRun: RunId | undefined) => !perRun || credentialRun === runId,
    /** Stamps this turn's run on a new credential when the session needs one per run. */
    issue: perRun && runId !== undefined ? { runId } : {},
  };
};
