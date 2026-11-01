import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

it.effect(
  "removes Cursor's task tool at a goatclaw limit of zero and reopens when it changes",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-subagents-" });
      const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-subagent-limit-thread");
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = {
        environmentId: EnvironmentId.make("fixture"),
        threadId,
        providerSessionId: "cursor-subagent-session",
        providerInstanceId: instanceId,
        endpoint: "http://fixture.invalid/mcp",
        authorizationHeader: "Bearer subagent-fixture",
        browserToolsAvailable: false,
      };
      yield* sessions.set(config);
      const opens: CursorAgentSdk.CursorAgentSdkOpenInput[] = [];
      let sends = 0;
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (openInput) =>
            Effect.sync(() => {
              opens.push(openInput);
              return {
                agentId: "native-cursor-subagents",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: () =>
                  Effect.sync(() => {
                    const runId = `native-cursor-run-${++sends}`;
                    return {
                      agentId: "native-cursor-subagents",
                      runId,
                      wait: Effect.succeed({
                        id: runId,
                        requestId: `native-request-${sends}`,
                        status: "finished" as const,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              };
            }),
        }),
        Effect.provide(hostContext),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-subagent-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const turn = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn({
            threadId,
            providerThread,
            modelSelection,
            runtimePolicy,
            runId: RunId.make(`cursor-subagent-run-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: RunAttemptId.make(`cursor-subagent-attempt-${ordinal}`),
            rootNodeId: NodeId.make(`cursor-subagent-root-${ordinal}`),
            appThread: {
              id: threadId,
              projectId: ProjectId.make("cursor-subagent-project"),
              createdBy: "user",
              creationSource: "web",
              title: "Cursor subagents",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
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
            },
            message: {
              messageId: MessageId.make(`cursor-subagent-message-${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: "continue",
              attachments: [],
            },
          });
          yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.runHead,
          );
        });

      // Cursor has no concurrency cap, so only zero changes the tools; exclusions are fixed at open.
      for (const [index, nativeSubagentLimit] of [undefined, 0, 2, 3].entries()) {
        yield* sessions.set(
          nativeSubagentLimit === undefined ? config : { ...config, nativeSubagentLimit },
        );
        yield* turn(index + 1);
      }
      assert.deepEqual(
        opens.map((open) => open.options.disallowedTools),
        [undefined, ["task"], undefined],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
);
