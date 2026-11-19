import * as NodeServices from "@effect/platform-node/NodeServices";
import { GitCommandError } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import { WorktreeHolderGuard } from "./WorktreeHolderGuard.ts";

it.effect("refuses client worktree removal when a holder is present", () => {
  const removed: string[] = [];
  const workflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
    removeWorktree: (input, guard?: (path: string) => Effect.Effect<void, GitCommandError>) =>
      (guard?.(input.path) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            removed.push(input.path);
          }),
        ),
      ),
  });
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const client = yield* GitWorkflowService.makeClientWorktrees;
    const path = `${config.worktreesDir}/repo/feature`;
    const outcome = yield* client.remove({ cwd: "/repo", path, force: true }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(outcome));
    assert.deepStrictEqual(removed, []);
  }).pipe(
    Effect.provideService(WorktreeHolderGuard, (path) =>
      Effect.fail(
        new GitCommandError({
          operation: "test",
          command: "git worktree remove",
          cwd: path,
          detail: "A thread still uses the worktree.",
        }),
      ),
    ),
    Effect.provide(
      Layer.mergeAll(
        workflow,
        ServerConfig.layerTest(process.cwd(), { prefix: "u45-holder-" }),
        ServerSettings.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
});
