import { ProviderDriverKind } from "@goat/contracts";
import { CLAUDE_MODEL_SELECTION, type OrchestratorReplayFixture } from "../shared.ts";
import { claudeResultIsErrorInput } from "./input.ts";
import { assertClaudeResultIsErrorOutput } from "./output.ts";
export const claudeResultIsErrorFixture = {
  name: "claude_result_is_error",
  buildInput: claudeResultIsErrorInput,
  providers: [
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      transcriptFile: new URL("./claude_transcript.ndjson", import.meta.url),
      modelSelection: CLAUDE_MODEL_SELECTION,
      assertOutput: assertClaudeResultIsErrorOutput,
    },
  ],
} satisfies OrchestratorReplayFixture;
