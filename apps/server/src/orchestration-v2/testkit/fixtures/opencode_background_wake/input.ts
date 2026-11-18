import type { OrchestratorFixtureInput } from "../shared.ts";

export const OPENCODE_BACKGROUND_WAKE_PROMPT =
  "Use the task tool once with background set to true to delegate to the general subagent with the prompt: Respond exactly CHILD_OK. As soon as it is launched, reply exactly PARENT_OK and end your turn without waiting for it.";

export function openCodeBackgroundWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE_BACKGROUND_WAKE_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
