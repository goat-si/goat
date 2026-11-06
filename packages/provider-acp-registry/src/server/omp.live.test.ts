// @effect-diagnostics nodeBuiltinImport:off - exercises a local executable and HTTP fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
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
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { ACP_LOCAL_PRESETS } from "../localPresets.ts";
import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import { makeAcpRegistryAdapterV2 } from "./adapter.ts";
import type { AcpRegistryLiveConfiguration } from "./probe.ts";

// GOAT_TEST_KEEP_PROVIDER_ENV=1 keeps GOAT_OMP_BIN through the shared test setup.
const binary = process.env.GOAT_OMP_BIN ?? "";
const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected registry request")),
  ),
);

describe.skipIf(binary === "")("Oh My Pi through the ACP registry adapter", () => {
  it.live.each(["accept", "decline"] as const)(
    "%s controls a bash call and advertises the mock model",
    (decision) =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-omp-live-"))),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const marker = NodePath.join(root, "marker");
        let requests = 0;
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const http = NodeHttp.createServer(async (request, response) => {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const body = JSON.parse(Buffer.concat(chunks).toString());
              const hasToolResult = body.messages.some(
                (message: { role: string }) => message.role === "tool",
              );
              requests++;
              const delta = hasToolResult
                ? { content: "Finished." }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_fixture",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({ command: `touch '${marker}'` }),
                        },
                      },
                    ],
                  };
              response.writeHead(200, { "Content-Type": "text/event-stream" });
              response.end(
                `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "mock-1", choices: [{ index: 0, delta, finish_reason: hasToolResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
              );
            });
            await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
            return http;
          }),
          (http) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) =>
                  http.close((error) => (error ? reject(error) : resolve())),
                ),
            ),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing fixture port");
        const agentDir = NodePath.join(root, ".omp", "agent");
        yield* Effect.promise(() => NodeFSP.mkdir(agentDir, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(agentDir, "models.yml"),
            JSON.stringify({
              providers: {
                "goat-mock": {
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  api: "openai-completions",
                  apiKey: "fixture",
                  models: [
                    {
                      id: "mock-1",
                      name: "Mock model",
                      input: ["text"],
                      contextWindow: 32768,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            }),
          ),
        );
        const preset = ACP_LOCAL_PRESETS.find((entry) => entry.id === "omp");
        if (!preset) throw new Error("Missing omp preset");
        const settings = yield* decodeSettings({
          source: "local",
          commandPath: binary,
          commandArgs: preset.args,
        });
        const environment = {
          HOME: root,
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: NodePath.join(root, "config"),
          XDG_CACHE_HOME: NodePath.join(root, "cache"),
          XDG_DATA_HOME: NodePath.join(root, "data"),
        };
        const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: root,
          toolsDir: root,
        });
        const instanceId = ProviderInstanceId.make("omp-live");
        let configuration: AcpRegistryLiveConfiguration | undefined;
        const adapter = yield* makeAcpRegistryAdapterV2({
          instanceId,
          settings,
          environment,
          selfInvocation: yield* resolveSelfInvocation(),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, catalog),
              Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
                withForegroundStartup: (_key, effect) => effect,
                publishAvailableCommands: () => Effect.void,
                publishLiveConfiguration: (_id, value) =>
                  Effect.sync(() => {
                    configuration = value;
                  }),
              }),
            ),
          ),
        );
        const threadId = ThreadId.make(`omp-live-${decision}`);
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: root,
        });
        const initialSelection = { instanceId, model: "default" };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`omp-live-${decision}`),
          modelSelection: initialSelection,
          runtimePolicy,
        });
        const model = configuration?.models.find((entry) => entry.id.includes("mock-1"));
        assert.isDefined(model, JSON.stringify(configuration));
        if (!model) throw new Error("Mock model missing");
        const modelSelection = { instanceId, model: model.id };
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("omp-live"),
            title: "OMP live",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "approval-required",
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
          threadId,
          runId: RunId.make(`omp-${decision}`),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make(`omp-${decision}`),
          rootNodeId: NodeId.make(`omp-${decision}`),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`omp-${decision}`),
            text: "Run the requested command.",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        let approved = false;
        while (true) {
          const event = yield* Queue.take(events);
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.status === "pending"
          ) {
            assert.equal(event.runtimeRequest.kind, "command");
            assert.isFalse(
              yield* Effect.promise(() =>
                NodeFSP.access(marker).then(
                  () => true,
                  () => false,
                ),
              ),
            );
            approved = true;
            yield* runtime.respondToRuntimeRequest({
              requestId: event.runtimeRequest.id,
              decision,
            });
          }
          if (event.type === "turn.terminal") {
            assert.equal(event.status, "completed", event.failure?.message);
            break;
          }
        }
        assert.isTrue(approved, "GOAT must surface the permission request");
        const exists = yield* Effect.promise(() =>
          NodeFSP.access(marker).then(
            () => true,
            () => false,
          ),
        );
        assert.equal(exists, decision === "accept");
        assert.isAtLeast(requests, 2);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
