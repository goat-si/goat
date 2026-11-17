import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";
import {
  applyClaudeSelectionToRunningQuery,
  claudeSelectionAppliesToRunningQuery,
} from "./ClaudeLiveSelection.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerErrors.ts";

const compiled = (
  apiModelId: string,
  effort: string | undefined,
  settings: Record<string, boolean> = {},
): CompiledClaudeModelSelection => ({
  apiModelId,
  effort,
  promptEffort: undefined,
  settings,
  queryIdentity: JSON.stringify({ apiModelId, effort: effort ?? null, settings }),
});

const running = {
  stopping: false,
  nativeThreadId: "native",
  selection: compiled("sonnet", "high"),
};

it("lets only an effort or fast mode change on the same model and thread reach a running Claude process", () => {
  const applies = (next: CompiledClaudeModelSelection, live = running, nativeId = "native") =>
    claudeSelectionAppliesToRunningQuery(live, next, nativeId);
  assert.isTrue(applies(compiled("sonnet", "medium")));
  assert.isTrue(applies(compiled("sonnet", "high", { fastMode: true })));
  // A model change waits for the turn that checks it against the turn's permission mode.
  assert.isFalse(applies(compiled("opus", "medium")));
  // Thinking needs a new process; clearing effort needs one to reload user settings.
  assert.isFalse(applies(compiled("sonnet", "high", { alwaysThinkingEnabled: true })));
  assert.isFalse(applies(compiled("sonnet", undefined)));
  assert.isFalse(applies(compiled("sonnet", "high")));
  assert.isFalse(applies(compiled("sonnet", "medium"), { ...running, stopping: true }));
  assert.isFalse(applies(compiled("sonnet", "medium"), running, "another-native-thread"));
});

it.effect(
  "a CLI that rejects the live change keeps its turn and leaves the change to the next turn",
  () =>
    Effect.gen(function* () {
      const live = {
        ...running,
        reportedModel: "sonnet",
        query: {
          setModel: () => Effect.die("an effort change keeps the model"),
          applyFlagSettings: () =>
            Effect.fail(
              new ClaudeAgentSdkQueryRunnerError({
                method: "applyFlagSettings",
                cause: "unknown control request",
              }),
            ),
        },
      };
      yield* applyClaudeSelectionToRunningQuery(live, compiled("sonnet", "medium"), "native");
      assert.equal(live.selection.queryIdentity, "");
      assert.equal(live.selection.effort, "high");
    }),
);
