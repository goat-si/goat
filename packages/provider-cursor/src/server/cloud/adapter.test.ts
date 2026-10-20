import type { AgentOptions, Run, RunResult, SDKMessage } from "@cursor/sdk";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import {
  ModelSelection,
  NodeId,
  ProviderInstanceId,
  ProviderSetupError,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  OrchestrationV2AppThread,
  ChatAttachment,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  DRIVER,
  capabilities,
  makeCursorCloudAdapter,
  resultTask,
  progressText,
} from "./adapter.ts";
import * as CursorCloudSdk from "./sdk.ts";

type Task = NonNullable<ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"]["cloudTask"]>;
const source = {
  repository: "https://github.com/fixture/repo",
  branch: "feature",
  sha: "a".repeat(40),
};
const agentId = "bc-fixture";
const runId = "run-fixture";
const appRunId = RunId.make("app-run-fixture");
const previousAppRunId = RunId.make("previous-app-run-fixture");
const instanceId = ProviderInstanceId.make("cursorCloud-fixture");
const task = (status: Task["status"] = "running"): Task => ({
  taskId: runId,
  acceptedAppRunId: appRunId,
  source,
  localChangesExcluded: true,
  status,
  tracking: "live",
  url: `https://cursor.com/agents/${agentId}`,
  updatedAt: "2026-10-13T00:00:00.000Z",
});
const completed: RunResult = {
  id: runId,
  status: "finished",
  result: "Implemented the requested change.",
  git: {
    branches: [
      {
        repoUrl: "github.com/fixture/repo",
        branch: "cursor/output",
        prUrl: "https://github.com/fixture/repo/pull/7",
      },
    ],
  },
};
const runtimePolicy = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  cwd: "/fixture",
};
const selection = Schema.decodeSync(ModelSelection)({ provider: instanceId, model: "auto" });

const decodeAppThread = Schema.decodeEffect(OrchestrationV2AppThread);
const decodeAttachment = Schema.decodeEffect(ChatAttachment);

const harness = Effect.gen(function* () {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamStarted = yield* Deferred.make<void>();
  const streamWaiting = yield* Deferred.make<void>();
  const firstLookup = yield* Deferred.make<void>();
  const secondLookup = yield* Deferred.make<void>();
  const runningObserved = yield* Deferred.make<void>();
  let runningLookup = false;
  let lookupCount = 0;
  let result = completed;
  const commits: Task[] = [];
  const refs: Array<
    Parameters<NonNullable<ProviderAdapter.ProviderAdapterV2TurnInput["commitCloudTask"]>>[1]
  > = [];
  const sendReceipts: Array<{ task: Task | undefined; refs: (typeof refs)[number] }> = [];
  const streamReceipts: Array<Task | undefined> = [];
  const detachedAfterClose: boolean[] = [];
  const close = vi.fn();
  const messages: SDKMessage[] = [
    { type: "status", agent_id: agentId, run_id: runId, status: "RUNNING" },
  ];
  const nativeRun: Run = {
    id: runId,
    agentId,
    createdAt: 1791849600000,
    status: "running",
    supports: () => true,
    unsupportedReason: () => undefined,
    stream: vi.fn(() => {
      streamReceipts.push(commits.at(-1));
      let index = 0;
      // Returning the iterator detaches even while the vendor stream's next is pending.
      // This models the SDK boundary's cancellation, not a timed test escape.
      const iterator: AsyncGenerator<SDKMessage, void> = {
        next: async () => {
          Deferred.doneUnsafe(streamStarted, Effect.void);
          if (index < messages.length) return { done: false, value: messages[index++]! };
          Deferred.doneUnsafe(streamWaiting, Effect.void);
          await gate;
          return { done: true, value: undefined };
        },
        return: async () => {
          detachedAfterClose.push(close.mock.calls.length > 0);
          return { done: true, value: undefined };
        },
        throw: async (error) => {
          throw error;
        },
        [Symbol.asyncIterator]: () => iterator,
        [Symbol.asyncDispose]: async () => {
          await iterator.return();
        },
      };
      return iterator;
    }),
    conversation: async () => [],
    wait: async () => result,
    cancel: async () => {},
    onDidChangeStatus: () => () => {},
  };
  const send = vi.fn(async () => {
    sendReceipts.push({ task: commits.at(-1), refs: refs.at(-1) });
    return nativeRun;
  });
  const create = vi.fn(async (_options: AgentOptions) => ({ agentId, send, close }));
  const resume = vi.fn(async (_id: string, _options: Partial<AgentOptions>) => ({
    agentId,
    send,
    close,
  }));
  const getRun = vi.fn(async (_id: string, _options: CursorCloudSdk.CloudRunOptions) => {
    lookupCount++;
    Deferred.doneUnsafe(lookupCount === 1 ? firstLookup : secondLookup, Effect.void);
    return { ...nativeRun, status: runningLookup ? ("running" as const) : result.status };
  });
  const cancelRun = vi.fn(async (_id: string, _options: CursorCloudSdk.CloudRunOptions) => {
    result = { id: runId, status: "cancelled" };
    release();
  });
  let listedRuns: Array<Run> = [nativeRun];
  const listRuns = vi.fn(async (_agentId: string, _options: CursorCloudSdk.CloudRunOptions) => ({
    items: listedRuns,
  }));
  const sdk = CursorCloudSdk.CursorCloudSdk.of({
    create,
    resume,
    getRun,
    cancelRun,
    listRuns,
    checkAccess: () => Effect.void,
    readModels: () => Effect.succeed([]),
  });
  const readKey = vi.fn((): Effect.Effect<string, ProviderSetupError> =>
    Effect.succeed("key-fixture"),
  );
  const adapter = yield* makeCursorCloudAdapter(instanceId, Effect.suspend(readKey)).pipe(
    Effect.provideService(CursorCloudSdk.CursorCloudSdk, sdk),
  );
  const threadId = ThreadId.make("thread-fixture");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-fixture"),
    modelSelection: selection,
    runtimePolicy,
  });
  const thread = yield* runtime.ensureThread({
    threadId,
    modelSelection: selection,
    runtimePolicy,
  });
  const appThread = yield* decodeAppThread({
    id: threadId,
    projectId: "project-fixture",
    title: "Fixture",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { provider: instanceId, model: "auto" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    forkedFrom: null,
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    createdAt: DateTime.makeUnsafe("2026-10-13T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-13T00:00:00.000Z"),
  });
  const input: ProviderAdapter.ProviderAdapterV2TurnInput = {
    appThread,
    threadId,
    runId: appRunId,
    attemptId: RunAttemptId.make("attempt-fixture"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    rootNodeId: NodeId.make("root-fixture"),
    providerThread: thread,
    cloudSource: source,
    modelSelection: selection,
    runtimePolicy,
    message: {
      messageId: "message-fixture" as ProviderAdapter.ProviderAdapterV2TurnMessage["messageId"],
      text: "Implement it",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    commitCloudTask: (value, nativeRefs) =>
      Effect.sync(() => {
        commits.push(value);
        refs.push(nativeRefs);
      }).pipe(
        Effect.andThen(
          value.status === "running" && value.tracking === "polled"
            ? Deferred.succeed(runningObserved, undefined)
            : Effect.void,
        ),
      ),
  };
  return {
    runtime,
    input,
    thread,
    commits,
    refs,
    create,
    resume,
    send,
    close,
    getRun,
    cancelRun,
    listRuns,
    setListedRuns: (value: Array<Run>) => {
      listedRuns = value;
    },
    nativeRun,
    streamStarted,
    streamWaiting,
    firstLookup,
    secondLookup,
    runningObserved,
    release,
    readKey,
    sendReceipts,
    streamReceipts,
    detachedAfterClose,
    messages,
    setRunningLookup: (value: boolean) => {
      runningLookup = value;
    },
    finish: Effect.sync(release),
    setResult: (value: RunResult) => {
      result = value;
    },
  };
});

const collectTerminal = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  Stream.runCollect(
    runtime.events.pipe(Stream.takeUntil((event) => event.type === "turn.terminal")),
  );

describe("Cursor Cloud adapter", () => {
  it("advertises cloud execution, follow-ups, cancel, and zero local checkpointing", () => {
    expect(capabilities.sessions.executionLocation).toBe("cloud");
    expect(capabilities.sessions.followUp.supported).toBe(true);
    expect(capabilities.checkpointing.appCanCheckpointFilesystem).toBe(false);
    expect(capabilities.turns.supportsSteeringByInterruptRestart).toBe(false);
  });
  effectIt.effect(
    "creates from remote SHA, commits identity before observation, then persists summary and PR",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.streamStarted);
        expect(h.commits.map((value) => value.status)).toContain("running");
        expect(h.create).toHaveBeenCalledWith(
          expect.objectContaining({
            cloud: {
              repos: [{ url: source.repository, startingRef: source.sha }],
              workOnCurrentBranch: false,
              autoCreatePR: true,
            },
          }),
        );
        expect(h.create.mock.calls[0]![0]).not.toHaveProperty("local");
        expect(h.refs[0]?.nativeThreadRef?.nativeId).toBe(agentId);
        expect(h.sendReceipts[0]).toMatchObject({
          task: { status: "submitting" },
          refs: { nativeThreadRef: { nativeId: agentId } },
        });
        expect(h.sendReceipts[0]?.task).not.toHaveProperty("acceptedAppRunId");
        expect(h.streamReceipts[0]).toMatchObject({ status: "running", taskId: runId });
        expect(h.streamReceipts[0]?.acceptedAppRunId).toBe(appRunId);
        expect(h.streamReceipts[0]).not.toHaveProperty("prUrl");
        expect(h.streamReceipts[0]).not.toHaveProperty("branch");
        yield* h.finish;
        const events = yield* collectTerminal(h.runtime);
        expect(
          events.filter(
            (event) =>
              event.type === "message.updated" ||
              event.type === "node.updated" ||
              event.type === "turn_item.updated",
          ),
        ).toHaveLength(0);
        expect(events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(h.commits.at(-1)).toMatchObject({
          status: "succeeded",
          summary: completed.result,
          prUrl: "https://github.com/fixture/repo/pull/7",
        });
        expect(h.getRun).toHaveBeenCalledWith(runId, {
          runtime: "cloud",
          agentId,
          apiKey: "key-fixture",
        });
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("keeps prior follow-up links until the new result replaces them", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime.startTurn({
        ...h.input,
        cloudSource: {
          repository: "https://github.com/fixture/other",
          branch: "other",
          sha: "b".repeat(40),
        },
        providerThread: {
          ...h.thread,
          nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" },
          cloudTask: {
            ...task("submitting"),
            acceptedAppRunId: previousAppRunId,
            summary: "previous summary",
            progress: "Previous progress",
            error: "Previous error",
            prUrl: "https://github.com/fixture/repo/pull/6",
            branch: "cursor/previous",
          },
        },
      });
      yield* Deferred.await(h.streamStarted);
      expect(h.resume).toHaveBeenCalledWith(agentId, { apiKey: "key-fixture" });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.commits[0]).toMatchObject({
        taskId: runId,
        status: "submitting",
        summary: "previous summary",
        acceptedAppRunId: previousAppRunId,
        source,
      });
      expect(h.commits.find((value) => value.status === "running")).not.toHaveProperty("summary");
      expect(h.commits.find((value) => value.status === "running")).not.toHaveProperty("progress");
      expect(h.commits.find((value) => value.status === "running")).not.toHaveProperty("error");
      expect(h.streamReceipts[0]).toMatchObject({
        prUrl: "https://github.com/fixture/repo/pull/6",
        branch: "cursor/previous",
        source,
      });
      expect(h.commits.find((value) => value.status === "running")?.acceptedAppRunId).toBe(
        appRunId,
      );
      expect(h.send).toHaveBeenCalledWith(
        "Implement it",
        expect.objectContaining({ idempotencyKey: expect.stringContaining("attempt-fixture") }),
      );
      expect(h.send).toHaveBeenCalledTimes(1);
      yield* h.finish;
      yield* collectTerminal(h.runtime);
      expect(h.commits.at(-1)).toMatchObject({
        status: "succeeded",
        summary: completed.result,
        prUrl: "https://github.com/fixture/repo/pull/7",
        branch: "cursor/output",
        source,
      });
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("reattaches the saved run and never consumes an unowned stream or resends", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      yield* h.runtime.resumeTurn!({
        ...attach,
        cloudTask: task(),
        providerThread: {
          ...h.thread,
          nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" },
          cloudTask: task(),
        },
      });
      const events = yield* collectTerminal(h.runtime);
      expect(events.some((event) => event.type === "turn.terminal")).toBe(true);
      expect(h.getRun).toHaveBeenCalledWith(runId, {
        runtime: "cloud",
        agentId,
        apiKey: "key-fixture",
      });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.cancelRun).not.toHaveBeenCalled();
      expect(h.nativeRun.stream).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("follows a registered agent's latest run without sending to it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      const registered: Task = {
        ...task(),
        taskId: agentId,
        tracking: "polled",
        attach: "registered",
      };
      yield* h.runtime.resumeTurn!({
        ...attach,
        cloudTask: registered,
        providerThread: {
          ...h.thread,
          nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" },
          cloudTask: registered,
        },
      });
      yield* collectTerminal(h.runtime);
      expect(h.listRuns).toHaveBeenCalledWith(agentId, {
        runtime: "cloud",
        agentId,
        apiKey: "key-fixture",
      });
      expect(h.commits[0]).toMatchObject({ taskId: runId, attach: "registered" });
      expect(h.getRun).toHaveBeenCalledWith(runId, expect.objectContaining({ agentId }));
      expect(h.create).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.cancelRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("stops following a registered run on Stop without cancelling it", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setRunningLookup(true);
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      const registered: Task = {
        ...task(),
        taskId: agentId,
        tracking: "polled",
        attach: "registered",
      };
      const nativeThreadRef = { driver: DRIVER, nativeId: agentId, strength: "strong" as const };
      yield* h.runtime.resumeTurn!({
        ...attach,
        cloudTask: registered,
        providerThread: { ...h.thread, nativeThreadRef, cloudTask: registered },
      });
      yield* Deferred.await(h.secondLookup);
      yield* h.runtime.interruptTurn({
        providerThread: {
          ...h.thread,
          nativeThreadRef,
          cloudTask: { ...registered, taskId: runId },
        },
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: DRIVER,
          nativeTurnId: `${instanceId}:${runId}`,
        }),
      });
      const events = yield* collectTerminal(h.runtime);
      expect(h.cancelRun).not.toHaveBeenCalled();
      expect(h.commits.at(-1)).toMatchObject({
        status: "running",
        tracking: "link-only",
        attach: "registered",
      });
      expect(events.filter((event) => event.type === "turn.terminal")).toEqual([
        expect.objectContaining({ status: "interrupted", failure: null }),
      ]);
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("refuses to follow a registered agent with no visible runs", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setListedRuns([]);
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      const registered: Task = {
        ...task(),
        taskId: agentId,
        tracking: "polled",
        attach: "registered",
      };
      const failure = yield* h.runtime.resumeTurn!({
        ...attach,
        cloudTask: registered,
        providerThread: {
          ...h.thread,
          nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" },
          cloudTask: registered,
        },
      }).pipe(Effect.flip);
      expect(String(failure.cause ?? failure.message)).toMatch(/no runs to follow/u);
      expect(h.getRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect.each(["absent", "previous"] as const)(
    "never looks up the previous task on repeated recovery with an %s acceptance marker",
    (marker) =>
      Effect.gen(function* () {
        const h = yield* harness;
        const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
        const { acceptedAppRunId: _acceptedAppRunId, ...previousTask } = task("submitting");
        let savedTask: Task = {
          ...previousTask,
          ...(marker === "previous" ? { acceptedAppRunId: previousAppRunId } : {}),
          summary: "Previous result",
          prUrl: "https://github.com/fixture/repo/pull/6",
          branch: "cursor/previous",
        };
        const nativeThreadRef = { driver: DRIVER, nativeId: agentId, strength: "strong" as const };
        const ids = yield* IdAllocator.IdAllocatorV2;
        for (let retry = 0; retry < 3; retry++) {
          const failure = yield* h.runtime.resumeTurn!({
            ...attach,
            cloudTask: savedTask,
            providerThread: { ...h.thread, nativeThreadRef, cloudTask: savedTask },
          }).pipe(Effect.flip);
          expect(failure._tag).toBe("ProviderAdapterProtocolError");
          savedTask = h.commits.at(-1)!;
          expect(savedTask).toMatchObject({
            taskId: runId,
            status: "unknown",
            source,
            url: `https://cursor.com/agents/${agentId}`,
            summary: "Previous result",
            prUrl: "https://github.com/fixture/repo/pull/6",
            branch: "cursor/previous",
          });
          expect(savedTask.acceptedAppRunId).toBe(
            marker === "previous" ? previousAppRunId : undefined,
          );
          const stopFailure = yield* h.runtime
            .interruptTurn({
              providerThread: { ...h.thread, nativeThreadRef, cloudTask: savedTask },
              providerTurnId: ids.derive.providerTurn({
                driver: DRIVER,
                nativeTurnId: `${instanceId}:${runId}`,
              }),
            })
            .pipe(Effect.flip);
          expect(stopFailure._tag).toBe("ProviderAdapterProtocolError");
        }
        expect(h.commits).toHaveLength(3);
        expect(h.refs).toEqual([undefined, undefined, undefined]);
        expect(h.create).not.toHaveBeenCalled();
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.readKey).not.toHaveBeenCalled();
        expect(h.getRun).not.toHaveBeenCalled();
        expect(h.cancelRun).not.toHaveBeenCalled();
        expect(h.nativeRun.stream).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("cancels the exact remote run and waits for observed terminal cancellation", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamStarted);
      yield* h.runtime.interruptTurn({
        providerThread: h.thread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: DRIVER,
          nativeTurnId: `${instanceId}:${runId}`,
        }),
      });
      const events = yield* collectTerminal(h.runtime);
      expect(h.cancelRun).toHaveBeenCalledWith(runId, {
        runtime: "cloud",
        agentId,
        apiKey: "key-fixture",
      });
      expect(h.commits.at(-1)?.status).toBe("cancelled");
      expect(events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("ambiguous recovery cannot reuse or cancel the previous active observer", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamWaiting);
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      const retained = task("submitting");
      const providerThread = {
        ...h.thread,
        nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" as const },
        cloudTask: retained,
      };
      const failure = yield* h.runtime.resumeTurn!({
        ...attach,
        runId: RunId.make("next-app-run-fixture"),
        providerThread,
        cloudTask: retained,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("ProviderAdapterProtocolError");
      const ids = yield* IdAllocator.IdAllocatorV2;
      yield* h.runtime
        .interruptTurn({
          providerThread,
          providerTurnId: ids.derive.providerTurn({
            driver: DRIVER,
            nativeTurnId: `${instanceId}:${runId}`,
          }),
        })
        .pipe(Effect.flip);
      expect(h.cancelRun).not.toHaveBeenCalled();
      expect(h.getRun).not.toHaveBeenCalled();
      expect(h.nativeRun.stream).toHaveBeenCalledTimes(1);
      yield* h.finish;
      yield* collectTerminal(h.runtime);
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("rejects absent remote SHA before creating or sending", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime
        .startTurn({
          ...h.input,
          cloudSource: { ...source, sha: undefined },
          providerThread: h.thread,
        })
        .pipe(Effect.flip);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("rejects attachments before any cloud SDK operation", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const attachment = yield* decodeAttachment({
        type: "file",
        id: "attachment-fixture",
        name: "input.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const failure = yield* h.runtime
        .startTurn({ ...h.input, message: { ...h.input.message, attachments: [attachment] } })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("ProviderAdapterProtocolError");
      expect(h.create).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.getRun).not.toHaveBeenCalled();
      expect(h.readKey).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect(
    "rejects restricted mode and explicit policy overrides before SDK operations",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const policies: Array<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = [
          { ...runtimePolicy, runtimeMode: "approval-required" },
          { ...runtimePolicy, approvalPolicy: "on-request" },
          { ...runtimePolicy, sandboxPolicy: { type: "readOnly" } },
        ];
        for (const policy of policies) {
          const failure = yield* h.runtime
            .startTurn({ ...h.input, runtimePolicy: policy })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("ProviderAdapterProtocolError");
        }
        expect(capabilities.runtimePolicy.enforcement).toBe("client-boundary");
        expect(h.create).not.toHaveBeenCalled();
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.readKey).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect(
    "scope disposal detaches a running observer without cancelling its remote run",
    () =>
      Effect.gen(function* () {
        const h = yield* Effect.gen(function* () {
          const fixture = yield* harness;
          yield* fixture.runtime.startTurn(fixture.input);
          yield* Deferred.await(fixture.streamWaiting);
          expect(fixture.commits.at(-1)?.status).toBe("running");
          return fixture;
        }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped);
        expect(h.close).toHaveBeenCalled();
        expect(h.detachedAfterClose).toEqual([true]);
        expect(h.cancelRun).not.toHaveBeenCalled();
        expect(h.commits.at(-1)?.status).toBe("running");
        h.release();
      }),
  );
  effectIt.effect(
    "ambiguous send failure persists unknown without retry or credential-bearing error",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const marker = "synthetic-cursor-credential-marker";
        const sdkException = Object.assign(new Error(`transport rejected ${marker}`), {
          apiKey: marker,
          request: { authorization: marker },
          cause: new Error(marker),
        });
        h.send.mockRejectedValue(sdkException);
        const failure = yield* h.runtime.startTurn(h.input).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "ProviderAdapterProtocolError",
          detail: "Cursor Cloud send failed.",
          cause: { _tag: "CursorCloudSdkError", operation: "send" },
        });
        const boundary =
          failure._tag === "ProviderAdapterProtocolError" ? failure.cause : undefined;
        expect(boundary).not.toBe(sdkException);
        expect(boundary).not.toHaveProperty("cause");
        expect(boundary).not.toHaveProperty("apiKey");
        expect(boundary).not.toHaveProperty("request");
        expect(JSON.stringify(failure)).not.toContain(marker);
        // The server logs a full Cause, rather than only the curated task metadata.
        expect(Cause.pretty(Cause.fail(failure))).not.toContain(marker);
        expect(h.commits.at(-1)).toMatchObject({ status: "unknown", source });
        expect(JSON.stringify(h.commits)).not.toContain(marker);
        expect(h.create).toHaveBeenCalledTimes(1);
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.nativeRun.stream).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("credential read failures expose no raw exception to the logged Cause", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const marker = "synthetic-cursor-key-read-marker";
      h.readKey.mockReturnValue(
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "credentials",
            detail: "Could not read sign-in.",
            cause: Object.assign(new Error(marker), { apiKey: marker }),
          }),
        ),
      );
      const failure = yield* h.runtime.startTurn(h.input).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterProtocolError",
        detail: "Cursor Cloud sign-in is unavailable.",
      });
      expect(failure).not.toHaveProperty("cause");
      expect(Cause.pretty(Cause.fail(failure))).not.toContain(marker);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("a failed post-create intent/agent-ref commit sends no prompt", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.runtime
        .startTurn({
          ...h.input,
          commitCloudTask: () =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: DRIVER,
                detail: "Fixture persistence failure.",
              }),
            ),
        })
        .pipe(Effect.flip);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.nativeRun.stream).not.toHaveBeenCalled();
      // Base's pre-create intent failure (zero creates too) is covered in real ingress CI.
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect(
    "failed accepted-run commit never exposes running observation or sends again",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.runtime
          .startTurn({
            ...h.input,
            commitCloudTask: (value, refs) =>
              value.status === "running"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: DRIVER,
                      detail: "Fixture persistence failure.",
                    }),
                  )
                : h.input.commitCloudTask!(value, refs),
          })
          .pipe(Effect.flip);
        expect(h.commits.at(-1)?.status).toBe("submitting");
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.nativeRun.stream).not.toHaveBeenCalled();
        expect(h.getRun).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect.each(["running", "unknown"] as const)(
    "restores a %s snapshot, clears tracking errors, then reconciles terminal on virtual time",
    (status) =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.setRunningLookup(true);
        const savedTask: Task = {
          ...task(status),
          ...(status === "unknown"
            ? {
                tracking: "polled" as const,
                error:
                  "Cloud tracking is unavailable. Work may continue; open the agent or restore sign-in.",
              }
            : {}),
        };
        const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
        yield* h.runtime.resumeTurn!({
          ...attach,
          cloudTask: savedTask,
          providerThread: {
            ...h.thread,
            nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" },
            cloudTask: savedTask,
          },
        });
        yield* Deferred.await(h.firstLookup);
        const restored = yield* Stream.runCollect(h.runtime.events.pipe(Stream.take(1)));
        expect(restored[0]).toMatchObject({
          type: "provider_turn.updated",
          providerTurn: {
            ordinal: 1,
            status: "running",
            nativeTurnRef: { nativeId: runId },
          },
        });
        const result = yield* collectTerminal(h.runtime).pipe(Effect.forkChild);
        yield* Deferred.await(h.runningObserved);
        expect(h.commits.at(-1)).toMatchObject({
          status: "running",
          tracking: "polled",
          taskId: runId,
          acceptedAppRunId: appRunId,
        });
        expect(h.commits.at(-1)).not.toHaveProperty("error");
        h.setRunningLookup(false);
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(h.secondLookup);
        const events = yield* Fiber.join(result);
        expect(events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(h.commits.at(-1)?.status).toBe("succeeded");
        expect(h.commits.at(-1)?.acceptedAppRunId).toBe(appRunId);
        expect(h.commits.at(-1)).not.toHaveProperty("error");
        expect(h.getRun).toHaveBeenCalledWith(runId, {
          runtime: "cloud",
          agentId,
          apiKey: "key-fixture",
        });
        expect(h.nativeRun.stream).not.toHaveBeenCalled();
        expect(h.send).not.toHaveBeenCalled();
        expect(h.create).not.toHaveBeenCalled();
        expect(h.resume).not.toHaveBeenCalled();
        expect(h.cancelRun).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("Stop still cancels the exact run after accepted unknown recovery", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setRunningLookup(true);
      const cancelled = yield* Deferred.make<void>();
      h.cancelRun.mockImplementation(async () => {
        h.setResult({ id: runId, status: "cancelled" });
        h.setRunningLookup(false);
        Deferred.doneUnsafe(cancelled, Effect.void);
      });
      const savedTask: Task = { ...task("unknown"), error: "Tracking was unavailable." };
      const providerThread = {
        ...h.thread,
        nativeThreadRef: { driver: DRIVER, nativeId: agentId, strength: "strong" as const },
        cloudTask: savedTask,
      };
      const { message: _message, cloudLaunchSource: _launchSource, ...attach } = h.input;
      yield* h.runtime.resumeTurn!({ ...attach, providerThread, cloudTask: savedTask });
      yield* Deferred.await(h.runningObserved);
      const ids = yield* IdAllocator.IdAllocatorV2;
      const stop = yield* h.runtime
        .interruptTurn({
          providerThread,
          providerTurnId: ids.derive.providerTurn({
            driver: DRIVER,
            nativeTurnId: `${instanceId}:${runId}`,
          }),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(cancelled);
      expect(h.cancelRun).toHaveBeenCalledWith(runId, {
        runtime: "cloud",
        agentId,
        apiKey: "key-fixture",
      });
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(stop);
      const events = yield* collectTerminal(h.runtime);
      expect(events.filter((event) => event.type === "turn.terminal")).toEqual([
        expect.objectContaining({ status: "interrupted" }),
      ]);
      expect(h.commits.at(-1)).toMatchObject({ status: "cancelled", acceptedAppRunId: appRunId });
      expect(h.nativeRun.stream).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("completion racing Stop stays succeeded and completed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.cancelRun.mockImplementation(async () => {
        h.setResult(completed);
        h.release();
      });
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamStarted);
      const ids = yield* IdAllocator.IdAllocatorV2;
      yield* h.runtime.interruptTurn({
        providerThread: h.thread,
        providerTurnId: ids.derive.providerTurn({
          driver: DRIVER,
          nativeTurnId: `${instanceId}:${runId}`,
        }),
      });
      const events = yield* collectTerminal(h.runtime);
      expect(events.filter((event) => event.type === "turn.terminal")).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(h.commits.at(-1)?.status).toBe("succeeded");
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect("cancel request failure never fabricates cancelled", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.cancelRun.mockRejectedValue(new Error("Fixture cancel refused."));
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamStarted);
      const ids = yield* IdAllocator.IdAllocatorV2;
      yield* h.runtime
        .interruptTurn({
          providerThread: h.thread,
          providerTurnId: ids.derive.providerTurn({
            driver: DRIVER,
            nativeTurnId: `${instanceId}:${runId}`,
          }),
        })
        .pipe(Effect.flip);
      expect(h.commits.some((value) => value.status === "cancelled")).toBe(false);
      expect(h.commits.at(-1)?.status).toBe("running");
      yield* h.finish;
      const events = yield* collectTerminal(h.runtime);
      expect(events.filter((event) => event.type === "turn.terminal")).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  it("does not accept another repository's result PR", () => {
    const output = resultTask(task(), {
      ...completed,
      git: {
        branches: [
          { repoUrl: "github.com/other/repo", prUrl: "https://github.com/other/repo/pull/1" },
        ],
      },
    });
    expect(output.prUrl).toBeUndefined();
    expect(output.branch).toBeUndefined();
  });
  it.each(["finished", "cancelled", "error"] as const)(
    "retains previous links when the authoritative %s result omits new git metadata",
    (status) => {
      const output = resultTask(
        {
          ...task(),
          prUrl: "https://github.com/fixture/repo/pull/6",
          branch: "cursor/previous",
        },
        { id: runId, status, result: "New result" },
      );
      expect(output).toMatchObject({
        summary: "New result",
        prUrl: "https://github.com/fixture/repo/pull/6",
        branch: "cursor/previous",
      });
    },
  );
  it.each(["finished", "cancelled", "error"] as const)(
    "replaces the stale observation alert for an authoritative %s result",
    (status) => {
      const output = resultTask(
        { ...task("unknown"), error: "Tracking was unavailable." },
        { ...completed, status },
      );
      if (status === "error") {
        expect(output).toMatchObject({
          status: "failed",
          error: "Cursor reported a terminal cloud error.",
        });
      } else {
        expect(output.status).toBe(status === "finished" ? "succeeded" : "cancelled");
        expect(output).not.toHaveProperty("error");
      }
    },
  );
  effectIt.effect("persists assistant progress separately from status and tool labels", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.messages.push(
        assistant("I'll locate"),
        tool("run_terminal_cmd", "running"),
        assistant(" the relevant file."),
        { ...assistant("Unowned text"), run_id: "another-run" },
        { ...assistant("Unowned agent"), agent_id: "another-agent" },
      );
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamWaiting);
      yield* h.finish;
      const events = yield* collectTerminal(h.runtime);
      expect(h.commits.at(-1)?.progress).toBe("I'll locate the relevant file.");
      expect(events.some((event) => event.type === "turn_item.updated")).toBe(false);
      expect(h.send).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  effectIt.effect(
    "publishes at most every 250ms while retaining unpublished assistant deltas",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const milestones = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ];
        const releases: Array<() => void> = [];
        const gates = milestones.map(() => new Promise<void>((resolve) => releases.push(resolve)));
        const messages = [assistant("I'll locate"), assistant(" the"), assistant(" file.")];
        let index = 0;
        const iterator: AsyncGenerator<SDKMessage, void> = {
          next: async () => {
            if (index > 0) {
              // The next pull proves the previous delta was processed, including any commit.
              Deferred.doneUnsafe(milestones[index - 1]!, Effect.void);
              await gates[index - 1];
            }
            if (index === messages.length) return { done: true, value: undefined };
            return { done: false, value: messages[index++]! };
          },
          return: async () => ({ done: true, value: undefined }),
          throw: async (error) => {
            throw error;
          },
          [Symbol.asyncIterator]: () => iterator,
          [Symbol.asyncDispose]: async () => {
            await iterator.return();
          },
        };
        vi.mocked(h.nativeRun.stream).mockReturnValue(iterator);
        yield* TestClock.adjust("250 millis");
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(milestones[0]!);
        expect(h.commits.at(-1)?.progress).toBe("I'll locate");
        const firstPublishCount = h.commits.length;
        yield* TestClock.adjust("249 millis");
        releases[0]!();
        yield* Deferred.await(milestones[1]!);
        expect(h.commits).toHaveLength(firstPublishCount);
        yield* TestClock.adjust("1 millis");
        releases[1]!();
        yield* Deferred.await(milestones[2]!);
        expect(h.commits).toHaveLength(firstPublishCount + 1);
        expect(h.commits.at(-1)?.progress).toBe("I'll locate the file.");
        releases[2]!();
        yield* collectTerminal(h.runtime);
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
  const assistant = (text: string): SDKMessage => ({
    type: "assistant",
    agent_id: agentId,
    run_id: runId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const tool = (name: string, status: "running" | "completed" | "error"): SDKMessage => ({
    type: "tool_call",
    agent_id: agentId,
    run_id: runId,
    call_id: "tool-fixture",
    name,
    status,
    args: { command: "private command" },
    result: "private tool result",
  });
  const emptyProgress = { assistantText: "", text: "" };
  it("replaces status with the assistant sentence instead of concatenating them", () => {
    const running = progressText(emptyProgress, {
      type: "status",
      agent_id: agentId,
      run_id: runId,
      status: "RUNNING",
    });
    expect(running.text).toBe("Cursor Cloud is running.");
    expect(progressText(running, assistant("I'll locate the relevant file.")).text).toBe(
      "I'll locate the relevant file.",
    );
  });
  it("keeps fragmented assistant context across tools and status updates", () => {
    let state = progressText(emptyProgress, assistant("I'll locate"));
    state = progressText(state, tool("run_terminal_cmd", "running"));
    expect(state.text).toBe("Running a command.");
    state = progressText(state, assistant(" the relevant file."));
    expect(state.text).toBe("I'll locate the relevant file.");
    state = progressText(state, {
      type: "status",
      agent_id: agentId,
      run_id: runId,
      status: "RUNNING",
    });
    state = progressText(state, assistant(" Now I'll fix"));
    state = progressText(state, assistant(" the adapter."));
    expect(state.text).toBe("Now I'll fix the adapter.");
    expect(state.assistantText).toBe("I'll locate the relevant file. Now I'll fix the adapter.");
  });
  it("normalizes display whitespace without removing whitespace from deltas", () => {
    let state = progressText(emptyProgress, assistant("First step.\n\nI'll"));
    state = progressText(state, assistant("\n\t locate"));
    state = progressText(state, assistant(" "));
    state = progressText(state, assistant("the file.\r\n"));
    expect(state.text).toBe("I'll locate the file.");
    expect(state.assistantText).toBe("First step.\n\nI'll\n\t locate the file.\r\n");
    expect(progressText(state, assistant("\t\n")).text).toBe("I'll locate the file.");
  });
  it.each(["completed", "error"] as const)(
    "starts fresh assistant text after a %s tool step",
    (status) => {
      let state = progressText(emptyProgress, assistant("I'll locate the file."));
      state = progressText(state, tool("read_file", status));
      state = progressText(state, assistant("I've found"));
      state = progressText(state, assistant(" the cause."));
      expect(state.text).toBe("I've found the cause.");
      expect(state.assistantText).toBe("I've found the cause.");
    },
  );
  it.each([
    ["run_terminal_cmd", "running", "Running a command."],
    ["shell", "completed", "Command completed."],
    ["edit_file", "error", "File edit failed."],
    ["read_file", "running", "Reading a file."],
    ["webSearch", "running", "Searching the web."],
    ["unknown_vendor_tool", "running", "Using a tool."],
    ["__proto__", "error", "Tool failed."],
  ] as const)("humanizes %s %s without exposing identifiers or payloads", (name, status, text) => {
    expect(progressText(emptyProgress, tool(name, status)).text).toBe(text);
  });
  it("redacts vendor error status details", () => {
    expect(
      progressText(emptyProgress, {
        type: "status",
        agent_id: agentId,
        run_id: runId,
        status: "ERROR",
        message: "private vendor error",
      }).text,
    ).toBe("Cursor Cloud reported an error. Open the agent for details.");
  });
  it("shows a short task line without mixing it into later assistant deltas", () => {
    const state = progressText(emptyProgress, {
      type: "task",
      agent_id: agentId,
      run_id: runId,
      text: "Inspecting\n\t the repository. Updating the adapter.",
    });
    expect(state.text).toBe("Updating the adapter.");
    expect(progressText(state, assistant("I'll check the result.")).text).toBe(
      "I'll check the result.",
    );
  });
  it("retains a bounded assistant accumulator and a short progress line", () => {
    const output = progressText(
      { assistantText: "x".repeat(8000), text: "Running a command." },
      {
        type: "assistant",
        agent_id: agentId,
        run_id: runId,
        message: { role: "assistant", content: [{ type: "text", text: "tail" }] },
      },
    );
    expect(output.assistantText.length).toBe(8000);
    expect(output.assistantText.endsWith("tail")).toBe(true);
    expect(output.text.length).toBeLessThanOrEqual(240);
  });
  it.each(["assistant", "task"] as const)(
    "clips %s progress at code point boundaries within 240 UTF-16 units",
    (type) => {
      for (const prefixLength of [237, 238, 239]) {
        const prefix = "x".repeat(prefixLength);
        const text = `${prefix}🚀more`;
        const output = progressText(
          emptyProgress,
          type === "assistant" ? assistant(text) : { type, agent_id: agentId, run_id: runId, text },
        );
        expect(output.text).toBe(`${prefix}${prefixLength === 237 ? "🚀" : ""}…`);
        expect(output.text.length).toBeLessThanOrEqual(240);
      }
    },
  );
  it("keeps a complete non-BMP character at the exact display limit", () => {
    const text = `${"x".repeat(238)}🚀`;
    expect(progressText(emptyProgress, assistant(text)).text).toBe(text);
  });
  it.each([7998, 7999, 8000])(
    "clips the assistant accumulator at code point boundaries with %s trailing UTF-16 units",
    (tailLength) => {
      const tail = "x".repeat(tailLength);
      const output = progressText(emptyProgress, assistant(`head🚀${tail}`));
      expect(output.assistantText).toBe(`${tailLength === 7998 ? "🚀" : ""}${tail}`);
      expect(output.assistantText.length).toBeLessThanOrEqual(8000);
    },
  );
  it("clips display progress after joining a surrogate pair split across deltas", () => {
    const prefix = "x".repeat(238);
    let state = progressText(emptyProgress, assistant(`${prefix}\uD83D`));
    state = progressText(state, assistant("\uDE80more"));
    expect(state.assistantText).toBe(`${prefix}🚀more`);
    expect(state.text).toBe(`${prefix}…`);
  });
  it("clips a reassembled surrogate pair as later deltas move the accumulator boundary", () => {
    const tail = "y".repeat(7998);
    let state = progressText(emptyProgress, assistant("head\uD83D"));
    state = progressText(state, assistant(`\uDE80${tail}`));
    expect(state.assistantText).toBe(`🚀${tail}`);
    expect(state.assistantText.length).toBe(8000);
    state = progressText(state, assistant("z"));
    expect(state.assistantText).toBe(`${tail}z`);
    expect(state.assistantText.length).toBe(7999);
    state = progressText(state, assistant("!"));
    expect(state.assistantText).toBe(`${tail}z!`);
    expect(state.assistantText.length).toBe(8000);
  });
  it("ignores duplicate user content and thinking", () => {
    const previous = { assistantText: "I'll locate the file.", text: "Reading a file." };
    expect(
      progressText(previous, {
        type: "user",
        agent_id: agentId,
        run_id: runId,
        message: { role: "user", content: [{ type: "text", text: "echo" }] },
      }),
    ).toEqual(previous);
    expect(
      progressText(previous, {
        type: "assistant",
        agent_id: agentId,
        run_id: runId,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-fixture", name: "raw_tool", input: {} }],
        },
      }),
    ).toEqual(previous);
    expect(
      progressText(previous, {
        type: "thinking",
        agent_id: agentId,
        run_id: runId,
        text: "private reasoning",
      }),
    ).toEqual(previous);
  });
});
