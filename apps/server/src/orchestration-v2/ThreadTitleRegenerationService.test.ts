import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  ChatAttachmentId,
  type ChatAttachment,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@goat/shared/composerContextReferences";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  options: {
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              hasCustomTitle: false,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        layerServerSettings,
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: (path) => Effect.succeed(path === "/existing-worktree") }),
        ),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
    ),
    generateThreadTitle,
  };
}

function createThread(input: {
  readonly command: string;
  readonly thread: string;
  readonly worktreePath?: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath ?? null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: input.attachments ?? [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

/** Records a settled source run with one exchange, as a provider turn would. */
function recordRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly user: string;
  readonly assistant: string;
  readonly status?: "completed" | "rolled_back";
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
    const message = (role: "user" | "assistant", text: string) => ({
      id: EventId.make(`${input.runId}:${role}`),
      type: "message.updated" as const,
      threadId: input.threadId,
      runId: input.runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`${input.runId}:${role}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${input.runId}:user`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status ?? "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${input.runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        message("user", input.user),
        message("assistant", input.assistant),
      ],
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

function forkSeededSource(prefix: string) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sourceThreadId = yield* createThread({
      command: `${prefix}:create`,
      thread: `${prefix}:source`,
    });
    const forkRunId = RunId.make(`${prefix}:run`);
    yield* recordRun({
      threadId: sourceThreadId,
      runId: forkRunId,
      ordinal: 1,
      user: "Source prompt",
      assistant: "Done",
    });
    const forkThreadId = ThreadId.make(`${prefix}:target`);
    yield* threads.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`${prefix}:fork`),
      sourceThreadId,
      targetThreadId: forkThreadId,
      sourcePoint: { type: "run", runId: forkRunId },
      createdBy: "user",
      creationSource: "web",
    });
    return { sourceThreadId, forkRunId, forkThreadId };
  });
}

describe("formatThreadTitleContext", () => {
  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect("keeps a title set before the first message unless it is a placeholder", () =>
    Effect.gen(function* () {
      const seed = "work on this and pr to dev";
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        // An MCP launch names the thread, or leaves a placeholder, and sends no message.
        for (const [key, title, expectedTitle, generates] of [
          ["preset", "[API] #4821 — retry webhook deliveries after a timeout", undefined, false],
          ["placeholder", "Parent thread 1", seed, true],
        ] as const) {
          const threadId = ThreadId.make(`thread:title:${key}`);
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`command:title:${key}:create`),
            threadId,
            projectId,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
          const requestId = CommandId.make(`command:title:${key}:message`);
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: requestId,
            threadId,
            messageId: MessageId.make(`command:title:${key}:message:message`),
            text: seed,
            titleSeed: seed,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
          });

          const settled = yield* threads.getThreadProjection(threadId);
          assert.equal(settled.thread.title, expectedTitle ?? title, key);
          assert.equal(
            (yield* outbox.listByCommandId(requestId)).some(
              (effect) => effect.request.type === "thread-title.generate",
            ),
            generates,
            key,
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a fork's own rename when its first message arrives", () =>
    Effect.gen(function* () {
      const seed = "Try SQLite instead";
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const prefix = "thread:title:renamed-fork";
        const { sourceThreadId, forkRunId, forkThreadId } = yield* forkSeededSource(prefix);
        const rename = (key: string, threadId: ThreadId, title: string) =>
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${prefix}:${key}:rename`),
            threadId,
            title,
          });
        const fork = (key: string) =>
          Effect.gen(function* () {
            const targetThreadId = ThreadId.make(`${prefix}:${key}`);
            yield* threads.dispatch({
              type: "thread.fork",
              commandId: CommandId.make(`${prefix}:${key}:fork`),
              sourceThreadId,
              targetThreadId,
              sourcePoint: { type: "run", runId: forkRunId },
              createdBy: "user",
              creationSource: "web",
            });
            return targetThreadId;
          });
        yield* rename("renamed", forkThreadId, "Storage migration notes");
        yield* rename("source", sourceThreadId, "Renamed source");
        const forkOfRenamedSource = yield* fork("fork-of-renamed-source");
        const regenerated = yield* fork("regenerated");
        yield* rename("regenerated", regenerated, "Scratch name");
        yield* titleRegeneration.execute({
          threadId: regenerated,
          requestId: yield* armRegeneration({
            command: `${prefix}:regenerated:regenerate`,
            threadId: regenerated,
          }),
          kind: { type: "regenerate" },
        });

        for (const [key, threadId, expectedTitle, generates] of [
          ["renamed", forkThreadId, "Storage migration notes", false],
          ["fork of a renamed source", forkOfRenamedSource, seed, true],
          ["renamed, then regenerated", regenerated, seed, true],
        ] as const) {
          const requestId = CommandId.make(`${prefix}:${key}:message`);
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: requestId,
            threadId,
            messageId: MessageId.make(`${prefix}:${key}:message:message`),
            text: seed,
            titleSeed: seed,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
          });

          const settled = yield* threads.getThreadProjection(threadId);
          assert.equal(settled.thread.title, expectedTitle, key);
          assert.equal(
            (yield* outbox.listByCommandId(requestId)).some(
              (effect) => effect.request.type === "thread-title.generate",
            ),
            generates,
            key,
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "titles an image-only first message without sending bootstrap text to the title model",
    () =>
      Effect.gen(function* () {
        for (const prefix of ["", "Ultrathink:\n"]) {
          const harness = makeHarness();
          yield* Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
            const threadId = yield* createThread({
              command: "image:create",
              thread: "image:thread",
            });
            const text = prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
            const attachments = [
              {
                type: "image" as const,
                id: ChatAttachmentId.make("diagram"),
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ];
            yield* dispatchUserMessage({ command: "image:message", threadId, text, attachments });
            const requestId = yield* armRegeneration({ command: "image:title", threadId });
            const messageId = MessageId.make("image:message:message");
            yield* service.execute({ threadId, requestId, kind: { type: "initial", messageId } });
            const call = harness.generateThreadTitle.mock.calls[0]?.[0];
            assert.equal(call?.message, "");
            assert.deepEqual(call?.attachments, attachments);
            const projection = yield* threads.getThreadProjection(threadId);
            assert.equal(projection.messages[0]?.text, text);
            assert.equal(projection.thread.title, "Generated title");
          }).pipe(Effect.provide(harness.layer));
        }
      }),
  );

  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:landing:create",
          thread: "thread:title:landing",
          worktreePath: "/removed-worktree",
        });
        yield* dispatchUserMessage({
          command: "command:title:landing:message",
          threadId,
          text: "Investigate the flaky login test",
        });
        const requestId = yield* armRegeneration({ command: "command:title:landing:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.previousTitle, "Seed title");
        assert.equal(call?.cwd, "/repo");
        assert.include(call?.message, "USER:\nInvestigate the flaky login test");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Fresh title");
        assert.isNotOk(projection.thread.titleRegeneration);
        const existingId = yield* createThread({
          command: "command:title:existing:create",
          thread: "thread:title:existing",
          worktreePath: "/existing-worktree",
        });
        yield* dispatchUserMessage({
          command: "command:title:existing:message",
          threadId: existingId,
          text: "Continue",
        });
        const existingRequest = yield* armRegeneration({
          command: "command:title:existing:1",
          threadId: existingId,
        });
        yield* titleRegeneration.execute({
          threadId: existingId,
          requestId: existingRequest,
          kind: { type: "regenerate" },
        });
        assert.equal(harness.generateThreadTitle.mock.calls[1]?.[0]?.cwd, "/existing-worktree");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("titles a fork's first message with the source history up to the fork point", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const sourceThreadId = yield* createThread({
          command: "command:title:fork:create",
          thread: "thread:title:fork:source",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:0"),
          ordinal: 1,
          user: "Rolled back attempt",
          assistant: "Discarded.",
          status: "rolled_back",
        });
        yield* TestClock.adjust("1 millis");
        const forkRunId = RunId.make("run:title:fork:1");
        yield* recordRun({
          threadId: sourceThreadId,
          runId: forkRunId,
          ordinal: 2,
          user: "Move session storage from Redis to Postgres",
          assistant: "Sessions now persist in the Postgres sessions table.",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:2"),
          ordinal: 3,
          user: "Later work the fork never saw",
          assistant: "Done.",
        });
        const forkThreadId = ThreadId.make("thread:title:fork:target");
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("command:title:fork:fork"),
          sourceThreadId,
          targetThreadId: forkThreadId,
          sourcePoint: { type: "run", runId: forkRunId },
          createdBy: "user",
          creationSource: "web",
        });
        const requestId = CommandId.make("command:title:fork:message");
        const messageId = MessageId.make("command:title:fork:message:message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: requestId,
          threadId: forkThreadId,
          messageId,
          text: "Try SQLite instead",
          titleSeed: "Try SQLite instead",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });

        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: { type: "initial", messageId },
        });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.message, "Try SQLite instead");
        assert.equal(call?.forkSource?.title, "Seed title");
        assert.include(call?.forkSource?.history, "Move session storage from Redis to Postgres");
        assert.include(call?.forkSource?.history, "Sessions now persist in the Postgres");
        assert.notInclude(call?.forkSource?.history, "Later work the fork never saw");
        assert.notInclude(call?.forkSource?.history, "Rolled back attempt");
        const fork = yield* threads.getThreadProjection(forkThreadId);
        assert.equal(fork.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("regenerates a fresh fork title from its inherited conversation", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const sourceThreadId = yield* createThread({
          command: "command:title:fresh-source",
          thread: "thread:title:fresh-source",
        });
        const runId = RunId.make("run:title:fresh-source");
        yield* recordRun({
          threadId: sourceThreadId,
          runId,
          ordinal: 1,
          user: "Inherited subject",
          assistant: "Inherited answer",
        });
        const threadId = ThreadId.make("thread:title:fresh-fork");
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("command:title:fresh-fork"),
          sourceThreadId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId },
          createdBy: "user",
          creationSource: "web",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:fresh-regenerate",
          threadId,
        });
        yield* service.execute({ threadId, requestId, kind: { type: "regenerate" } });
        assert.include(
          harness.generateThreadTitle.mock.calls[0]?.[0]?.forkSource?.history,
          "Inherited subject",
        );
        assert.equal(
          (yield* threads.getThreadProjection(threadId)).thread.title,
          "Generated title",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "records the outcome of a regeneration: renamed, failed without the CLI's text, unchanged",
    () =>
      Effect.gen(function* () {
        const cases = [
          { name: "renamed", generateTitle: () => Effect.succeed({ title: "Fresh title" }) },
          {
            name: "failed",
            generateTitle: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail:
                    "Codex CLI command failed: OpenAI Codex\nuser\nConversation text\nmodel unavailable\n",
                }),
              ),
          },
          { name: "unchanged", generateTitle: () => Effect.succeed({ title: "Seed title" }) },
        ] as const;
        for (const testCase of cases) {
          const harness = makeHarness({ generateTitle: testCase.generateTitle });
          yield* Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
            const threadId = yield* createThread({
              command: `command:title:outcome:${testCase.name}:create`,
              thread: `thread:title:outcome:${testCase.name}`,
            });
            yield* dispatchUserMessage({
              command: `command:title:outcome:${testCase.name}:message`,
              threadId,
              text: "Some conversation",
            });
            const requestId = yield* armRegeneration({
              command: `command:title:outcome:${testCase.name}:1`,
              threadId,
            });

            yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

            const projection = yield* threads.getThreadProjection(threadId);
            assert.isNotOk(projection.thread.titleRegeneration);
            assert.deepInclude(
              projection.thread.lastTitleRegeneration,
              testCase.name === "failed"
                ? { requestId, status: "failed", message: "Title generation failed." }
                : { requestId, status: testCase.name },
            );
            // A CLI's raw output stays in the server log; the stored outcome carries none of it.
            assert.notInclude(JSON.stringify(projection.thread), "model unavailable");
            assert.notInclude(JSON.stringify(projection.thread), "Conversation text");
            assert.equal(
              projection.thread.title,
              testCase.name === "renamed" ? "Fresh title" : "Seed title",
            );
          }).pipe(Effect.provide(harness.layer));
        }
      }),
  );

  it.effect("records no outcome for a first-message title", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "initial:create",
          thread: "initial:thread",
        });
        yield* dispatchUserMessage({ command: "initial:message", threadId, text: "Fix the login" });
        const requestId = yield* armRegeneration({ command: "initial:title", threadId });
        const messageId = MessageId.make("initial:message:message");
        yield* service.execute({ threadId, requestId, kind: { type: "initial", messageId } });
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Generated title");
        assert.isNotOk(projection.thread.lastTitleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("records a failed outcome when generation outlives its two-minute deadline", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ generateTitle: () => Effect.never });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({ command: "slow:create", thread: "slow:thread" });
        yield* dispatchUserMessage({
          command: "slow:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "slow:title", threadId });
        const running = yield* service
          .execute({ threadId, requestId, kind: { type: "regenerate" } })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 minutes");
        yield* Fiber.join(running);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.deepInclude(projection.thread.lastTitleRegeneration, {
          requestId,
          status: "failed",
          message: "Title generation took longer than two minutes.",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
