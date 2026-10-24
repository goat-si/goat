import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { pullRequestWakeMessageId } from "./goat/PullRequestWatchWakes.ts";
import { HOST_PRESSURE_MESSAGE_PREFIX } from "../fleet/pressure/pressureModel.ts";
import { finishedWake, newLaunchWatch } from "../mcp/launchWatch.ts";
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

const second = { ...key, number: 8 };
const secondUrl = "https://github.com/pingdotgg/t3code/pull/8";

/** An idle thread watching #7 and #8, each with one update kept as context. */
const threadWithKeptContext = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`pr-kept-${name}`);
    const projectId = ProjectId.make(`pr-kept-${name}-project`);
    yield* seedProject({
      projectId,
      title: "Kept",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      createdAt: "2026-10-23T00:00:00.000Z",
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`pr-kept-${name}-create`),
      threadId,
      projectId,
      title: "Kept",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    const kept = [
      [key, url, ["all 3 checks passed on aaaaaaa"], { headSha: "aaaaaaaaaa", passed: true }],
      [second, secondUrl, ['1 new comment, latest from vercel[bot]: "Preview ready"'], {}],
    ] as const;
    for (const [pr, prUrl] of kept)
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`pr-kept-${name}-watch-${pr.number}`),
        threadId,
        ...pr,
        watching: true,
        link: { url: prUrl, source: "agent" },
      });
    const shell = yield* orchestrator.getThreadShell(threadId);
    const links = shell?.pullRequests ?? [];
    for (const [pr, , heldContext, state] of kept) {
      const watch = links.find((link) => link.number === pr.number)?.watch;
      if (watch === undefined) return yield* Effect.die("no watch");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`pr-kept-${name}-hold-${pr.number}`),
        threadId,
        ...pr,
        startedAt: watch.startedAt,
        watch: { ...watch, ...state, heldContext },
        note: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: `#${pr.number}: kept as context`,
        },
      });
    }
    const startedText = Effect.map(
      orchestrator.getThreadRecords(threadId, ["runs", "messages"]),
      ({ runs, messages }) =>
        runs
          .filter((run) => run.status !== "queued")
          .map((run) => messages.find((message) => message.id === run.userMessageId)?.text),
    );
    const heldLeft = Effect.map(orchestrator.getThreadShell(threadId), (thread) =>
      (thread?.pullRequests ?? []).flatMap((link) => link.watch?.heldContext ?? []),
    );
    return { orchestrator, threadId, links, startedText, heldLeft };
  });

describe("pull request updates kept as context (#1055)", () => {
  it.effect("a watch ending on its comment limit tells its kept context once, in one write", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, links } = yield* threadWithKeptContext("limit");
      const link = links.find((candidate) => candidate.number === 8)!;
      const current = Effect.map(orchestrator.getThreadShell(threadId), (shell) =>
        shell!.pullRequests!.find((candidate) => candidate.number === 8)!,
      );
      const watch = (yield* current).watch!;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-limit-conflict"),
        threadId,
        ...second,
        startedAt: watch.startedAt,
        watch: { ...watch, conflicting: true, heldContext: ["conflicts with main"] },
        note: { source: { kind: "monitor" }, outcome: "updated", summary: "#8: kept" },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-limit-end"),
        threadId,
        ...second,
        startedAt: watch.startedAt,
        watch: null,
        // The ending pass merged cleanly and kept one more bot comment.
        endedWatch: {
          ...watch,
          conflicting: false,
          heldContext: ['1 new comment, latest from vercel[bot]: "Preview updated"'],
        },
        wake: {
          messageId: pullRequestWakeMessageId(link, "limit"),
          text: "GOAT stopped watching after 10 comment-only updates in a row.",
          notification,
        },
      });
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      const text = messages.find(
        (message) => message.id === pullRequestWakeMessageId(link, "limit"),
      )?.text;
      expect(text?.match(/Also kept as context/g)).toHaveLength(1);
      expect(text).toContain('2 new comments, latest from vercel[bot]: "Preview updated"');
      expect(text).not.toContain("conflicts with main");
      const ended = yield* current;
      expect(ended.watch).toBeUndefined();
      expect(ended.endedWatch?.heldContext).toBeUndefined();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a notice left alone under a dropped wake's id survives the next push", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, links } = yield* threadWithKeptContext("refold");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-refold-work"),
        threadId,
        messageId: MessageId.make("message:pr-kept-refold-work"),
        text: "Keep working.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const link = links.find((candidate) => candidate.number === 7)!;
      const watchAt = (headSha: string) =>
        Effect.map(orchestrator.getThreadShell(threadId), (shell) => ({
          ...shell!.pullRequests!.find((candidate) => candidate.number === 7)!.watch!,
          headSha,
          heldContext: [],
        }));
      const sync = (name: string, headSha: string, wake?: { id: string; text: string }) =>
        Effect.flatMap(watchAt(headSha), (watch) =>
          orchestrator.dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-kept-refold-${name}`),
            threadId,
            ...key,
            startedAt: watch.startedAt,
            watch,
            ...(wake === undefined
              ? {}
              : {
                  wake: {
                    messageId: MessageId.make(wake.id),
                    text: wake.text,
                    notification,
                  },
                }),
          }),
        );
      const pressure = (level: string) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`pr-kept-refold-${level}`),
          threadId,
          messageId: MessageId.make(`${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:${level}`),
          text: `Resource pressure: box-a is ${level}.`,
          attachments: [],
          notification: { source: { kind: "monitor" }, outcome: "updated", summary: "box-a" },
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
      const checksId = pullRequestWakeMessageId(link, "refold", "1111111aaaa");
      yield* sync("checks", "1111111aaaa", { id: checksId, text: "Checks failed on 1111111." });
      yield* pressure("elevated");
      yield* sync("push-1", "2222222bbbb");
      // The newer pressure notice replaces the older one in the turn the check wake opened.
      yield* pressure("critical");
      yield* sync("push-2", "3333333cccc");
      const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      const queued = runs.find((run) => run.userMessageId === checksId);
      expect(queued?.status).toBe("queued");
      const text = messages.find((message) => message.id === checksId)?.text;
      expect(text).toContain("Resource pressure: box-a is critical.");
      expect(text).not.toContain("Checks failed on 1111111.");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a queued notice on another model tells kept context once", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, startedText, heldLeft } =
        yield* threadWithKeptContext("model");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-model-work"),
        threadId,
        messageId: MessageId.make("message:pr-kept-model-work"),
        text: "Keep working.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const lane = finishedWake({
        watch: newLaunchWatch({
          launcherThreadId: threadId,
          host: null,
          threadId: ThreadId.make("thread:lane-a"),
          projectId: null,
          title: "lane-a",
          incarnation: "test",
          notifyWebhook: false,
          now: 0,
        }),
        runId: RunId.make("run:lane-a"),
        status: "completed",
        title: "lane-a",
        branch: null,
        worktreePath: null,
        excerpt: "lane-a is done.",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-model-lane"),
        threadId,
        messageId: lane.messageId,
        text: lane.text,
        attachments: [],
        notification: lane.notification,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      // The run end keeps the model it was queued on, so starting it changes the selection.
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("pr-kept-model-switch"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const work = runs.find((run) => run.userMessageId === "message:pr-kept-model-work")!;
      const now = yield* DateTime.now;
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:pr-kept-model-work-ended"),
            type: "run.updated",
            threadId,
            runId: work.id,
            occurredAt: now,
            payload: { ...work, status: "interrupted", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("pr-kept-model-resume"),
        threadId,
      });
      const told = (yield* startedText).find((text) => text?.includes("lane-a is done."));
      expect(told).toContain("all 3 checks passed on aaaaaaa");
      expect(told).toContain("Preview ready");
      expect(yield* heldLeft).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a closing watch tells only what no turn has told yet", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, links, heldLeft } = yield* threadWithKeptContext("closing");
      // A notice turn tells both pull requests' context while the host read is under way.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-closing-pressure"),
        threadId,
        messageId: MessageId.make(`${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:1`),
        text: "Resource pressure: box-a is elevated.",
        attachments: [],
        notification: { source: { kind: "monitor" }, outcome: "updated", summary: "box-a" },
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      expect(yield* heldLeft).toEqual([]);
      const link = links.find((candidate) => candidate.number === 7)!;
      const shell = yield* orchestrator.getThreadShell(threadId);
      const watch = shell?.pullRequests?.find((candidate) => candidate.number === 7)?.watch;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-closing-hold"),
        threadId,
        ...key,
        startedAt: watch!.startedAt,
        watch: { ...watch!, conflicting: true, heldContext: ["conflicts with main"] },
        note: { source: { kind: "monitor" }, outcome: "updated", summary: "#7: kept as context" },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-closing-end"),
        threadId,
        ...key,
        startedAt: watch!.startedAt,
        watch: null,
        dropQueuedWakes: true,
        wake: {
          messageId: pullRequestWakeMessageId(link, "closing"),
          text: "Pull request #7 was closed, so GOAT stopped watching it.",
          notification,
        },
      });
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      const closing = messages.find(
        (message) => message.id === pullRequestWakeMessageId(link, "closing"),
      )?.text;
      expect(closing).toContain("Also kept as context without waking you: conflicts with main");
      expect(closing).not.toContain("all 3 checks passed");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a queued notice turn carries what was kept while it waited", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, link, watch, statusOf } = yield* watchWithQueuedWake("wait");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-wait-hold"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: { ...watch, heldContext: ["all 3 checks passed on aaaaaaa"] },
        note: { source: { kind: "monitor" }, outcome: "updated", summary: "#7: kept as context" },
      });
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const first = runs.find(
        (run) => run.userMessageId === pullRequestWakeMessageId(link, "wait-first"),
      );
      // The running wake ends, so the queue moves on to the next turn.
      const now = yield* DateTime.now;
      yield* (yield* EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:pr-kept-wait-first-ended"),
            type: "run.updated",
            threadId,
            runId: first!.id,
            occurredAt: now,
            payload: { ...first!, status: "interrupted", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("pr-kept-wait-resume"),
        threadId,
      });
      expect(yield* statusOf("second")).not.toBe("queued");
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      const text = messages.find(
        (message) => message.id === pullRequestWakeMessageId(link, "wait-second"),
      )?.text;
      expect(text).toContain("The branch now conflicts with dev.");
      expect(text?.match(/^Pull request #7 .*all 3 checks passed on aaaaaaa$/m)).not.toBeNull();
      const shell = yield* orchestrator.getThreadShell(threadId);
      expect(shell?.pullRequests?.[0]?.watch?.heldContext).toBeUndefined();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a merged pull request leaves a shared digest and the other notices stay", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, link, watch, statusOf } = yield* watchWithQueuedWake("share");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-share-pressure"),
        threadId,
        messageId: MessageId.make(`${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:1`),
        text: "Resource pressure: box-a is elevated.",
        attachments: [],
        notification: { source: { kind: "monitor" }, outcome: "updated", summary: "box-a" },
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      const messageOf = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.find((message) => message.id === pullRequestWakeMessageId(link, "share-second"))
            ?.text,
      );
      // The pressure notice waits in the pull request's queued turn.
      expect(yield* messageOf).toContain("Resource pressure: box-a is elevated.");
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-share-merged"),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: null,
        dropQueuedWakes: true,
      });
      expect(yield* statusOf("second")).toBe("queued");
      const text = yield* messageOf;
      expect(text).toContain("Resource pressure: box-a is elevated.");
      expect(text).not.toContain("The branch now conflicts with dev.");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("two pull requests kept as context reach the next turn as one digest", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, startedText, heldLeft } =
        yield* threadWithKeptContext("digest");
      // Keeping context never starts a turn by itself.
      expect(yield* startedText).toEqual([]);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-kept-digest-pressure"),
        threadId,
        messageId: MessageId.make(`${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:1`),
        text: "Resource pressure: box-a is elevated.",
        attachments: [],
        notification: { source: { kind: "monitor" }, outcome: "updated", summary: "box-a" },
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      const [text, ...others] = yield* startedText;
      expect(others).toEqual([]);
      expect(text).toContain('<notices count="3">');
      expect(text).toContain("Resource pressure: box-a is elevated.");
      expect(text?.match(/^Pull request #7 .*all 3 checks passed on aaaaaaa$/m)).not.toBeNull();
      expect(text?.match(/^Pull request #8 .*Preview ready"$/m)).not.toBeNull();
      // Told once: the next turn does not repeat them.
      expect(yield* heldLeft).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a wake carries what other pull requests kept as context in the same turn", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, links, startedText, heldLeft } =
        yield* threadWithKeptContext("react");
      const link = links.find((candidate) => candidate.number === 8)!;
      const shell = yield* orchestrator.getThreadShell(threadId);
      const watch = shell!.pullRequests!.find((candidate) => candidate.number === 8)!.watch!;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-kept-react-wake"),
        threadId,
        ...second,
        startedAt: watch.startedAt,
        watch: { ...watch, heldContext: [] },
        wake: {
          messageId: pullRequestWakeMessageId(link, "react"),
          text: 'alice on src/index.ts: "Please rename this."',
          notification,
        },
      });
      const [text, ...others] = yield* startedText;
      expect(others).toEqual([]);
      expect(text).toContain("Please rename this.");
      expect(text).toContain("all 3 checks passed on aaaaaaa");
      expect(text).toContain("Preview ready");
      expect(yield* heldLeft).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );
});
