import { pickGoatBotEnvironment } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { readEnvironments, readPrimaryEnvironmentId } from "~/state/environments";
import { goatBotEnvironmentInputs } from "./goatBotHooks";

/** The environment GOAT Bot runs on now, chosen as the roster chooses it, for answer-time checks. */
export function readGoatBotEnvironmentId(): EnvironmentId | null {
  const environments = goatBotEnvironmentInputs(readEnvironments(), readPrimaryEnvironmentId());
  return (
    pickGoatBotEnvironment(environments, useGlobalAgentStore.getState().botRef)?.environmentId ??
    null
  );
}
