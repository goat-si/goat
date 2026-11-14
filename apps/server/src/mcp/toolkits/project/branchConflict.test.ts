import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness, withLaunchService } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("a launch into a new worktree creates nothing when its branch collides", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchBranchConflictError({
            projectId,
            projectTitle: "Client target",
            branch: workspaceStrategy.branch ?? "",
            conflictingBranch: "werkstatt",
          }),
        ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const refused = (yield* toolkit
      .handle("goat_thread_launch", {
        title: "Fix",
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "werkstatt/baseline" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)))).at(
      -1,
    )?.result;
    expect(refused).toMatchObject({
      code: "invalid_request",
      message:
        'Branch "werkstatt/baseline" cannot be created in project "Client target": branch "werkstatt" exists. No thread was created. Use a name that does not nest under or contain an existing branch, such as "werkstatt-baseline".',
    });
    expect(launched).toHaveLength(0);
  }),
);
