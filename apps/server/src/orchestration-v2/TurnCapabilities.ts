import type { OrchestrationV2ConversationMessage, TurnCapability } from "@goat/contracts";
import { requestedTurnCapabilities } from "@goat/shared/turnCapabilities";

import { continuationOrigin } from "./ContinuationChain.ts";

/**
 * What the turn's `@computer` / `@browser` chips asked for. A continuation keeps asking for
 * what the message it continues asked for.
 */
export function runTurnCapabilities(
  input: Parameters<
    typeof continuationOrigin<Pick<OrchestrationV2ConversationMessage, "text" | "context">>
  >[0],
): ReadonlyArray<TurnCapability> {
  const origin = continuationOrigin(input);
  if (origin === undefined) return [];
  return requestedTurnCapabilities({
    text: origin.message.text,
    records: origin.message.context?.records ?? [],
  });
}

/**
 * A chip is the person asking for that capability on this turn, so `@browser` opens preview
 * tools a project default left off. Computer use has no override here: its own gates
 * (setting, plan mode, read-only, unattended lease) decide whether the driver attaches.
 */
export function withTurnAgentAccess(
  access: { readonly browser: boolean; readonly device: boolean },
  turnCapabilities: ReadonlyArray<TurnCapability> | undefined,
): { readonly browser: boolean; readonly device: boolean } {
  return {
    browser: access.browser || turnCapabilities?.includes("browser") === true,
    device: access.device,
  };
}
