import { ProviderDriverKind } from "@goat/contracts";
import { CLAUDE_MODEL_SELECTION, type OrchestratorReplayFixture } from "../shared.ts";
import { simpleInput } from "../simple/input.ts";
import { assertClaudeUsageLimitOutput } from "./claude_output.ts";
export const usageLimitFixture = {
  name: "usage_limit",
  buildInput: simpleInput,
  providers: [
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      transcriptFile: new URL("./claude_transcript.ndjson", import.meta.url),
      modelSelection: CLAUDE_MODEL_SELECTION,
      assertOutput: assertClaudeUsageLimitOutput,
    },
  ],
} satisfies OrchestratorReplayFixture;
