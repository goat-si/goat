import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness, withLaunchService } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("keeps the work kind GOAT Bot's machine forwarded with its launcher", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(withLaunchService(dependencies)),
        ),
      ),
    );
    const launcher = {
      kind: "launch" as const,
      environmentLabel: "studio",
      threadTitle: "GOAT Bot",
      threadId: ThreadId.make("channel-worker:task-1"),
      environmentId: EnvironmentId.make("bot-environment"),
      via: "ssh_thread_launch" as const,
      workKind: "chore" as const,
    };
    const result = yield* toolkit
      .handle("goat_thread_launch", { title: "Restart", projectId, launchedBy: launcher })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(withLaunchService(dependencies)));
    expect(result.at(-1)?.result).toMatchObject({ projectId });
    expect(launched[0]?.launchedBy).toEqual(launcher);
  }),
);
