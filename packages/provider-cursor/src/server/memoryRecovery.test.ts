import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Exit from "effect/Exit";
import { MemoryId, MemoryRevisionId, MemorySpaceId } from "@goat/contracts";
import { packMemoryContext } from "@goat/provider-core/server/memoryContext";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { CursorSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

import * as Fiber from "effect/Fiber";
import * as CursorSdk from "./CursorSdk.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import type { SDKUserMessage } from "@cursor/sdk";
import { vi } from "vite-plus/test";

const sdk = vi.hoisted(() => ({
  send: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock("./sdk.ts", () => ({
  Agent: {
    create: async () => ({ agentId: "recovery-agent", send: sdk.send, close: () => {} }),
    resume: async () => ({ agentId: "recovery-agent", send: sdk.send, close: () => {} }),
    listRuns: async () => ({ items: [{ id: "abandoned-run", status: "running" }] }),
    cancelRun: sdk.cancelRun,
    messages: { list: async () => [] },
  },
  createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => async () => {} }),
  SqliteLocalAgentStore: { open: vi.fn() },
}));
const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("Cursor memory recovery admission", () => {
  it.effect.each(["removed", "replaced", "tampered"] as const)(
    "WP4 Cursor recovery refreshes %s memory before native resend",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-recovery-" });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-recovery-thread");
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const snapshot = wp4Snapshot();
        let memory: typeof snapshot | undefined = snapshot;
        let refreshes = 0;
        const cancelling = Promise.withResolvers<void>();
        const continueCancel = Promise.withResolvers<void>();
        const messages: Array<string | SDKUserMessage> = [];
        sdk.send.mockReset();
        sdk.send.mockImplementation(async (message: string | SDKUserMessage) => {
          messages.push(message);
          if (messages.length === 1) throw new Error("Agent recovery-agent already has active run");
          return {
            id: "recovered-run",
            agentId: "recovery-agent",
            wait: async () => ({
              id: "recovered-run",
              requestId: "fixture",
              status: "finished",
              model: { id: "composer-2.5" },
              durationMs: 1,
            }),
            cancel: async () => {},
          };
        });
        sdk.cancelRun.mockReset();
        sdk.cancelRun.mockImplementation(() => {
          cancelling.resolve();
          return continueCancel.promise;
        });
        const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
        const host = yield* Effect.service(ProviderHost.ProviderHost).pipe(
          Effect.provide(hostContext),
        );
        yield* fileSystem.writeFileString(
          `${host.paths.attachmentsDir}/memory.png`,
          "fixture image",
        );
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
        }).pipe(
          Effect.provide(
            CursorAgentSdk.layer.pipe(
              Layer.provide(CursorSdk.layer),
              Layer.provide(
                Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
                  native: undefined,
                  canonical: undefined,
                }),
              ),
            ),
          ),
          Effect.provide(hostContext),
        );
        const bootstrap = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-error-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* bootstrap.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        // A fresh app session must resume the existing native agent, enabling abandoned-run recovery.
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-resumed-session"),
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const appThread = {
          id: threadId,
          projectId: ProjectId.make("cursor-error-project"),
          createdBy: "user" as const,
          creationSource: "web" as const,
          title: "Cursor transport failure",
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
        const ordinaryInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          memoryContext: snapshot,
          refreshMemoryContext: () =>
            Effect.sync(() => {
              refreshes++;
              return memory;
            }),
          runId: RunId.make("cursor-error-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-error-attempt"),
          rootNodeId: NodeId.make("cursor-error-root"),
          appThread,
          message: {
            messageId: MessageId.make("cursor-error-message"),
            createdBy: "user",
            creationSource: "web",
            text: "continue",
            attachments: [],
          },
        };
        const pending = yield* runtime
          .startTurn({
            ...ordinaryInput,
            message: {
              ...ordinaryInput.message,
              attachments: [
                {
                  type: "image",
                  id: "memory.png",
                  name: "memory.png",
                  mimeType: "image/png",
                  sizeBytes: 13,
                },
              ],
            },
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Effect.promise(() => cancelling.promise);
        assert.equal(refreshes, 1);
        const replacement = wp4Snapshot("replacement & <safe>");
        memory =
          change === "removed"
            ? undefined
            : change === "replaced"
              ? replacement
              : { ...snapshot, renderedText: "forged-frame" };
        continueCancel.resolve();
        const result = yield* Fiber.join(pending);
        assert.equal(refreshes, 2);
        assert.equal(sdk.cancelRun.mock.calls.length, 1);
        if (change === "tampered") {
          assert.isTrue(Exit.isFailure(result));
          assert.equal(messages.length, 1);
        } else {
          assert.isTrue(Exit.isSuccess(result));
          yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.runHead,
          );
          assert.equal(messages.length, 2);
          const first = messages[0]!;
          const second = messages[1]!;
          assert.isNotString(first);
          assert.isNotString(second);
          if (typeof first !== "string" && typeof second !== "string") {
            assert.include(first.text, "external_goat_memory");
            assert.include(first.text, "&amp; &lt;instruction&gt;");
            assert.deepEqual(second.images, first.images);
            assert.lengthOf(second.images!, 1);
            assert.include(second.text, "continue");
            assert.notInclude(second.text, "&lt;instruction&gt;");
            if (change === "removed") assert.notInclude(second.text, "external_goat_memory");
            else {
              assert.include(second.text, "replacement &amp; &lt;safe&gt;");
              assert.include(second.text, "external_goat_memory");
            }
          }
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );
});
const wp4Snapshot = (text = "& <instruction> 'data'") =>
  packMemoryContext({
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text,
      },
    ],
  })!;
