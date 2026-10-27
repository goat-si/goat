import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProjectSetupScriptCompletion } from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";

export const awaitSetupCompletion = Effect.fn("ThreadLaunchService.awaitSetupCompletion")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly completion: Effect.Effect<ProjectSetupScriptCompletion>;
    readonly note: (line: string) => Effect.Effect<void>;
  }) {
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const completion = yield* input.completion;
    yield* input.note(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
    yield* tracker.stage(input.threadId, "setup-script", {
      status: completion.exitCode === 0 ? "done" : "failed",
      detail: `exited with ${completion.exitCode ?? "no exit code"}`,
    });
    return completion.exitCode === 0;
  },
);
