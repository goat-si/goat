import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { clientLaunchHarness, withLaunchService } from "./handlers.testkit.ts";
import { ProjectToolkit } from "./tools.ts";

// Pi offers no Auto; a mode a provider lacks would run as Supervised.
const pi: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: true,
  status: "ready",
  version: null,
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
};

const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const { projectId, dependencies } = clientLaunchHarness({
    runtimeModeCeiling: "auto",
    launched,
    providers: [pi],
  });
  const layer = withLaunchService(dependencies);
  const toolkit = yield* ProjectToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(layer)),
    ),
  );
  const result = yield* toolkit
    .handle("goat_thread_launch", {
      projectId,
      title: "Fix",
      modelSelection: { instanceId: pi.instanceId, model: "pi-model" },
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
    })
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer));
  return { result: result.at(-1)?.result, launched };
});

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it.effect("an update the project refuses tells the agent why", () =>
  Effect.gen(function* () {
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const detail = "Project monograms must contain at most two characters.";
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.fail(new Project.ProjectInvalidError({ projectId: input.projectId, detail })),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    const refused = yield* toolkit
      .handle("goat_project_update", {
        projectId: harness.projectId,
        projectIcon: { kind: "monogram", text: "ABC", color: "blue" },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(refused.at(-1)?.result).toMatchObject({ code: "invalid_request", message: detail });
  }),
);
