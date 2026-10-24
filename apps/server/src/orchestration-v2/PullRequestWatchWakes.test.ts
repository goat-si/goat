import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { pullRequestWakeMessageId } from "./goat/PullRequestWatchWakes.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");
const prWatchDisabledProjectId = ProjectId.make("pr-watch-disabled-project");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.none()),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([providerInstance, alternateProviderInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [prWatchDisabledProjectId]: { pullRequestWatchPolicy: { autoWatch: false } },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
const url = "https://github.com/pingdotgg/t3code/pull/7";
const notification = {
  source: { kind: "monitor" as const },
  outcome: "failed" as const,
  summary: "#7: merge conflict",
};

/** A watched pull request whose first wake is running and second wake is queued behind it. */
const watchWithQueuedWake = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`pr-wakes-${name}`);
    const projectId = ProjectId.make(`pr-wakes-${name}-project`);
    yield* seedProject({
      projectId,
      title: "Watched",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      createdAt: "2026-10-23T00:00:00.000Z",
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`pr-wakes-${name}-create`),
      threadId,
      projectId,
      title: "Watched",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`pr-wakes-${name}-watch`),
      threadId,
      ...key,
      watching: true,
      link: { url, source: "agent" },
    });
    const shell = yield* orchestrator.getThreadShell(threadId);
    const link = shell?.pullRequests?.[0];
    const watch = link?.watch;
    if (link === undefined || watch === undefined) return yield* Effect.die("no watch");
    for (const wake of ["first", "second"])
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`pr-wakes-${name}-${wake}`),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch,
        wake: {
          messageId: pullRequestWakeMessageId(link, `${name}-${wake}`),
          text: "The branch now conflicts with dev.",
          notification,
        },
      });
    const statusOf = (wake: string) =>
      Effect.map(
        orchestrator.getThreadRecords(threadId, ["runs"]),
        ({ runs }) =>
          runs.find(
            (run) => run.userMessageId === pullRequestWakeMessageId(link, `${name}-${wake}`),
          )?.status,
      );
    expect(yield* statusOf("second")).toBe("queued");
    return { orchestrator, threadId, link, watch, statusOf };
  });

describe("pull request watch wakes", () => {
  it.effect("a merged pull request's queued wake never starts a turn", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, watch, statusOf } = yield* watchWithQueuedWake("merged");
      const first = yield* statusOf("first");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-wakes-merged-end"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: null,
        dropQueuedWakes: true,
      });
      expect(yield* statusOf("second")).toBe("cancelled");
      // The wake already under way is the agent's current turn; it is left alone.
      expect(yield* statusOf("first")).toBe(first);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a closed pull request drops its queued wakes and still says it closed", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, link, watch, statusOf } =
        yield* watchWithQueuedWake("closed");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-wakes-closed-end"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: null,
        dropQueuedWakes: true,
        wake: {
          messageId: pullRequestWakeMessageId(link, "closed-notice"),
          text: "Pull request #7 was closed, so GOAT stopped watching it.",
          notification: {
            ...notification,
            outcome: "updated",
            summary: "#7: closed, stopped watching",
          },
        },
      });
      expect(yield* statusOf("second")).toBe("cancelled");
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      expect(
        runs.find((run) => run.userMessageId === pullRequestWakeMessageId(link, "closed-notice"))
          ?.status,
      ).toBe("queued");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["unwatch", "unlink"] as const)(
    "stopping a watch by %s drops its queued wakes",
    (stop) =>
      Effect.gen(function* () {
        const { orchestrator, threadId, statusOf } = yield* watchWithQueuedWake(stop);
        yield* orchestrator.dispatch(
          stop === "unwatch"
            ? {
                type: "thread.pull-request.watch",
                commandId: CommandId.make(`pr-wakes-${stop}-stop`),
                threadId,
                ...key,
                watching: false,
              }
            : {
                type: "thread.pull-request.unlink",
                commandId: CommandId.make(`pr-wakes-${stop}-stop`),
                threadId,
                ...key,
              },
        );
        expect(yield* statusOf("second")).toBe("cancelled");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a sync that only records progress keeps the queued wakes", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, watch, statusOf } = yield* watchWithQueuedWake("progress");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-wakes-progress-record"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: { ...watch, headSha: "abc123" },
      });
      expect(yield* statusOf("second")).toBe("queued");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a push drops the queued check result for the head it replaced (#1056)", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, link, watch } = yield* watchWithQueuedWake("pushed");
      const old = { ...watch, headSha: "1111111aaaa" };
      for (const [name, checksOn] of [
        ["old-checks", "1111111aaaa"],
        ["old-comment", undefined],
      ] as const)
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`pr-wakes-pushed-${name}`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: old,
          wake: {
            messageId: pullRequestWakeMessageId(link, `pushed-${name}`, checksOn),
            text: checksOn === undefined ? "1 new comment." : "Checks failed on 1111111.",
            notification,
          },
        });
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-wakes-pushed-new-head"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: { ...watch, headSha: "2222222bbbb" },
      });
      const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      const queued = runs.filter((run) => run.status === "queued");
      const texts = queued.map(
        (run) => messages.find((message) => message.id === run.userMessageId)?.text ?? "",
      );
      // The conflict and the comment still hold on the new head; the old head's checks do not.
      expect(texts.join("\n")).not.toContain("Checks failed on 1111111.");
      expect(texts.join("\n")).toContain("1 new comment.");
      expect(texts.join("\n")).toContain("The branch now conflicts with dev.");
    }).pipe(Effect.provide(layerTest)),
  );
});
