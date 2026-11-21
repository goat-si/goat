import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { SYNTHETIC_CLAUDE_CAPABLE_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

it.layer(layerClaudeTextGenerationTest)("Claude investigation settings", (it) => {
  it.effect("loads only user settings when generating review guides", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { stops: [] } }),
        argsMustContain: "--setting-sources user",
        expectedTools: "Read,Grep,Glob,Bash",
      },
      (textGeneration) =>
        textGeneration.generateReviewGuide({
          cwd: process.cwd(),
          number: 12,
          title: "Review a change",
          description: "",
          baseBranch: "main",
          baseCommit: "base",
          settledReview: "",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          ),
        }),
    ),
  );
});
