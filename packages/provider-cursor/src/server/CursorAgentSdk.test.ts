import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ThreadId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  MemoryId,
  MemoryRevisionId,
  MemorySpaceId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { packMemoryContext } from "@goat/provider-core/server/memoryContext";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  const sentMessages: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      message: string | { text: string },
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      sentMessages.push(typeof message === "string" ? message : message.text);
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async (_agentId: string) => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    sentMessages,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: vi.fn() },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "preserves the adapter memory correction across active-run recovery (restore grant: %s)",
    (restoreGrant) =>
      Effect.gen(function* () {
        cursorSdkMock.runOperations.length = 0;
        cursorSdkMock.sentMessages.length = 0;
        cursorSdkMock.resume.mockClear();
        cursorSdkMock.setStaleRunActive(false);
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-memory-recovery-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-memory-recovery");
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const attachment = {
          environmentId: EnvironmentId.make("fixture"),
          threadId,
          providerSessionId: "cursor-memory-recovery",
          providerInstanceId: instanceId,
          endpoint: "http://fixture.invalid/mcp",
          authorizationHeader: "Bearer synthetic-fixture",
          browserToolsAvailable: false,
          grantedScopes: ["memory:read"] as const,
        };
        yield* sessions.set(attachment);
        const retryAttachment = { ...attachment, authorizationHeader: "Bearer synthetic-recovery" };
        // Use the production runner; only its SDK Agent is the fixture above.
        const runner = yield* CursorAgentSdk.makeCursorAgentSdkRunner(() => undefined).pipe(
          Effect.provide(CursorSdk.layer),
        );
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
        }).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, runner),
          Effect.provide(TestProviderHost.layer({ cwd: workspace })),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-memory-recovery"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const appThread = {
          id: threadId,
          projectId: ProjectId.make("cursor-memory-recovery"),
          createdBy: "user" as const,
          creationSource: "web" as const,
          title: "Memory recovery",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const snapshot = packMemoryContext({
          memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
          projectionWatermark: 1,
          items: [
            {
              memoryId: MemoryId.make("00000000-0000-4000-8000-000000000001"),
              revisionId: MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
              scope: { kind: "user" },
              provenance: { environmentId: EnvironmentId.make("fixture") },
              assertionKind: "fact",
              text: "recovery snapshot",
            },
          ],
        })!;
        let refreshes = 0;
        const input: ProviderAdapter.ProviderAdapterV2TurnInput = {
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          appThread,
          runId: RunId.make("cursor-memory-recovery"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-memory-recovery"),
          rootNodeId: NodeId.make("cursor-memory-recovery"),
          message: {
            messageId: MessageId.make("cursor-memory-recovery"),
            createdBy: "user",
            creationSource: "web",
            text: "continue",
            attachments: [],
          },
          refreshMemoryContext: () =>
            Effect.gen(function* () {
              refreshes++;
              if (refreshes === 3 && restoreGrant) yield* sessions.set(retryAttachment);
              // Recovery must refresh the snapshot rather than reuse the first message.
              return refreshes === 3 ? snapshot : undefined;
            }),
        };
        const finishTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* runtime.startTurn({
              ...input,
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
            });
            const terminal = yield* runtime.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.runHead,
            );
            assert.isTrue(Option.isSome(terminal));
            if (Option.isSome(terminal)) assert.equal(terminal.value.status, "completed");
          });
        yield* finishTurn(1);
        assert.include(cursorSdkMock.sentMessages[0]!, "read=true, write=false, source=false");
        yield* sessions.clear(threadId);
        if (restoreGrant) yield* sessions.set({ ...retryAttachment, grantedScopes: [] });
        cursorSdkMock.setStaleRunActive(true);
        cursorSdkMock.runOperations.length = 0;
        yield* finishTurn(2);
        assert.deepStrictEqual(cursorSdkMock.runOperations, [
          "run.start",
          "agent.listRuns",
          "agent.cancelRun",
          "run.start",
        ]);
        assert.equal(cursorSdkMock.resume.mock.calls.at(-1)?.[0], "agent-cursor-agent-sdk-test");
        assert.include(cursorSdkMock.sentMessages[1]!, "read=false, write=false, source=false");
        assert.notInclude(cursorSdkMock.sentMessages[1]!, "recovery snapshot");
        assert.include(cursorSdkMock.sentMessages[2]!, "recovery snapshot");
        assert.include(
          cursorSdkMock.sentMessages[2]!,
          `read=${restoreGrant}, write=false, source=false`,
        );
        assert.equal(refreshes, 3);
        yield* sessions.clear(threadId);
        yield* finishTurn(3);
        if (restoreGrant) {
          assert.include(cursorSdkMock.sentMessages[3]!, "read=false, write=false, source=false");
          yield* finishTurn(4);
          assert.notInclude(cursorSdkMock.sentMessages[4]!, "GOAT memory tools:");
        } else {
          assert.notInclude(cursorSdkMock.sentMessages[3]!, "GOAT memory tools:");
        }
        assert.equal(refreshes, restoreGrant ? 5 : 4);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );
});
