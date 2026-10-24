import type { AgentOptions, Run, RunResult, SDKMessage } from "@cursor/sdk";
import { vi } from "vite-plus/test";
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeCursorCloudAdapter } from "./adapter.ts";
import * as CursorCloudSdk from "./sdk.ts";

export type Task = NonNullable<
  ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"]["cloudTask"]
>;
export const source = {
  repository: "https://github.com/fixture/repo",
  branch: "feature",
  sha: "a".repeat(40),
};
export const agentId = "bc-fixture";
export const runId = "run-fixture";
export const appRunId = RunId.make("app-run-fixture");
export const previousAppRunId = RunId.make("previous-app-run-fixture");
export const instanceId = ProviderInstanceId.make("cursorCloud-fixture");
export const task = (status: Task["status"] = "running"): Task => ({
  taskId: runId,
  acceptedAppRunId: appRunId,
  source,
  localChangesExcluded: true,
  status,
  tracking: "live",
  url: `https://cursor.com/agents/${agentId}`,
  updatedAt: "2026-10-13T00:00:00.000Z",
});
export const completed: RunResult = {
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
export const runtimePolicy = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  cwd: "/fixture",
};
export const selection = Schema.decodeSync(ModelSelection)({ provider: instanceId, model: "auto" });

export const decodeAppThread = Schema.decodeEffect(OrchestrationV2AppThread);
export const decodeAttachment = Schema.decodeEffect(ChatAttachment);

export const harness = Effect.gen(function* () {
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
          const value = messages[index];
          if (value !== undefined) {
            index++;
            return { done: false, value };
          }
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
