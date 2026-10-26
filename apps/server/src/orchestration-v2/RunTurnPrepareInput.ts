import { runScreenBindingHints } from "./McpPrepareInput.ts";
import { runTurnCapabilities } from "./TurnCapabilities.ts";

/** What prepare reads from the run besides memory: its capability chips and screen binding hints. */
export const runTurnPrepareInput = (
  input: Parameters<typeof runTurnCapabilities>[0] & Parameters<typeof runScreenBindingHints>[0],
) => ({ turnCapabilities: runTurnCapabilities(input), ...runScreenBindingHints(input) });
