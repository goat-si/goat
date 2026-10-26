import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

type RuntimeInstructionsInput = Parameters<typeof buildRuntimeInstructions>[0];

/** The thread's MCP session decides whether the turn carries the screen code guide. */
export const buildSessionRuntimeInstructions = (
  skills: RuntimeInstructionsInput["skills"],
  runtime: Omit<RuntimeInstructionsInput, "skills">,
) => buildRuntimeInstructions({ ...runtime, skills });
