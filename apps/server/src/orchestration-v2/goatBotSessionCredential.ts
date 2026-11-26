import {
  isGoatBotSessionThreadId,
  type ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
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
 * OpenCode refreshes its remote MCP configuration before each ordinary thread turn. Bind that
 * credential to the run so recall receipts identify the requesting turn. Bot sessions follow
 * their driver’s session-sharing policy.
 */
export const sessionRunScope = (
  threadId: ThreadId,
  driver: ProviderDriverKind | undefined,
  runId: RunId | undefined,
) => {
  const perRun = isGoatBotSessionThreadId(threadId)
    ? goatBotSessionSharingFor(driver) === "per_run"
    : driver === "opencode";
  return {
    /** Whether a credential issued for `credentialRun` may serve this turn. */
    serves: (credentialRun: RunId | undefined) => !perRun || credentialRun === runId,
    /** Stamps this turn's run on a new credential when the session needs one per run. */
    issue: { providerDriver: driver, ...(perRun && runId !== undefined ? { runId } : {}) },
  };
};
