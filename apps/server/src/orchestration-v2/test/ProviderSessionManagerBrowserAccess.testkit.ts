import { ProjectId, type Project } from "@goat/contracts";

export function makeBrowserAccessProject(projectId: ProjectId): Project {
  return {
    id: projectId,
    title: "Browser access project",
    workspaceRoot: process.cwd(),
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

import { ThreadId, type TurnCapability } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as EventSink from "../EventSink.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { emptyState, modelSelection, runtimePolicy } from "../ProviderSessionFixture.testkit.ts";
import { makeThreadCreatedEvent } from "./ProviderSessionManagerMemoryDto.testkit.ts";
import { layerTest } from "./ProviderSessionManagerHarness.testkit.ts";

export function runBrowserAccessScenario(input: {
  readonly enableAgentBrowserAccess: boolean;
  readonly projectOverride: boolean;
  readonly deviceOverride?: boolean;
  readonly enableAgentDeviceAccess?: boolean;
  readonly enableDeviceSupport?: boolean;
  readonly createThread?: boolean;
  readonly projectExists?: boolean;
  readonly turnCapabilities?: ReadonlyArray<TurnCapability>;
}) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const projectId = ProjectId.make("project-provider-session-manager-browser-access");
    const threadId = ThreadId.make("thread-provider-session-manager-browser-access");
    const layerProjectService = Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeed(
          input.projectExists === false
            ? Option.none()
            : Option.some(makeBrowserAccessProject(requestedProjectId)),
        ),
    });
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      if (input.createThread !== false) {
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now, projectId })],
        });
      }
      const { turnCapabilities = [] } = input;
      yield* manager
        .open({ threadId, providerSessionId, modelSelection, runtimePolicy, turnCapabilities })
        .pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          projectServiceLayer: layerProjectService,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: input.enableAgentBrowserAccess,
            enableAgentDeviceAccess: input.enableAgentDeviceAccess ?? false,
            enableDeviceSupport: input.enableDeviceSupport ?? true,
            projectSettingsOverrides: {
              [projectId]: {
                enableAgentBrowserAccess: input.projectOverride,
                ...(input.deviceOverride === undefined
                  ? {}
                  : { enableAgentDeviceAccess: input.deviceOverride }),
              },
            },
          }),
        }),
      ),
    );
    return (yield* Ref.get(mcpConfigs))[0];
  });
}
