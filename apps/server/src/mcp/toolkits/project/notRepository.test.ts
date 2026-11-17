import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness, withLaunchService } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

const refusal = (checkFailed?: string) =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId }) =>
        Effect.fail(
          new ThreadLaunch.ThreadLaunchNotRepositoryError({
            projectId,
            projectTitle: "Notes",
            workspaceRoot: "/work/notes",
            ...(checkFailed === undefined ? {} : { checkFailed }),
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
    const result = (yield* toolkit
      .handle("goat_thread_launch", {
        title: "Fix",
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)))).at(
      -1,
    )?.result;
    return { result, launched };
  });

it.effect("a worktree launch in a project that is not a Git repository creates nothing", () =>
  Effect.gen(function* () {
    const { result, launched } = yield* refusal();
    expect(result).toMatchObject({
      code: "invalid_request",
      message:
        'Project "Notes" (/work/notes) is not a Git repository. No thread was created. Use workspaceStrategy {"type":"root"}, or pass the projectId of a Git repository.',
    });
    expect(launched).toHaveLength(0);
  }),
);

it.effect("a worktree launch GOAT could not check for a Git repository creates nothing", () =>
  Effect.gen(function* () {
    const { result, launched } = yield* refusal("git timed out");
    expect(result).toMatchObject({
      code: "invalid_request",
      message:
        'GOAT could not check whether project "Notes" (/work/notes) is a Git repository (git timed out). No thread was created. Try again, or use workspaceStrategy {"type":"root"} to work in the project folder without a new worktree.',
    });
    expect(launched).toHaveLength(0);
  }),
);
