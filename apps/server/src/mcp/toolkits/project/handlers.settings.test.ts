import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("reading a project shows the default model saved in Settings", () =>
  Effect.gen(function* () {
    const overrideModel = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet",
    };
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      overrideModel,
      launched: [],
    });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({
            id: projectId,
            title: "Client target",
            workspaceRoot: "/projects/client-target",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const read = yield* toolkit
      .handle("goat_project_read", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(read.at(-1)?.result).toMatchObject({ defaultModelSelection: overrideModel });
  }),
);
