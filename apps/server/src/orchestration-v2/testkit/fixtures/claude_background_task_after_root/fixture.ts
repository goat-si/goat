import { ProviderDriverKind } from "@goat/contracts";
import { CLAUDE_MODEL_SELECTION, type OrchestratorReplayFixture } from "../shared.ts";
import { claudeBackgroundTaskAfterRootInput } from "./input.ts";
import { assertClaudeBackgroundTaskAfterRootOutput } from "./output.ts";

export const claudeBackgroundTaskAfterRootFixture: OrchestratorReplayFixture = {
  name: "claude_background_task_after_root",
  buildInput: claudeBackgroundTaskAfterRootInput,
  providers: [
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      transcriptFile: new URL("./claude_transcript.ndjson", import.meta.url),
      modelSelection: CLAUDE_MODEL_SELECTION,
      assertOutput: assertClaudeBackgroundTaskAfterRootOutput,
    },
  ],
};
