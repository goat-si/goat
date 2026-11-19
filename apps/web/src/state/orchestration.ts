import { createOrchestrationEnvironmentAtoms } from "@goat/client-runtime/state/orchestration";

import { environmentShell } from "./shell";
import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  shellState: environmentShell.stateValueAtom,
});
