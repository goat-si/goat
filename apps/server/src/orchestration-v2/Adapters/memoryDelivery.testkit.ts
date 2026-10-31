// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as Fiber from "effect/Fiber";
import { runAcpMcpStdioBridge } from "../../mcp/AcpMcpStdioBridge.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { packMemoryContext, memoryContextText } from "@goat/provider-core/server/memoryContext";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import { makeAcpAdapterV2, AcpProviderCapabilitiesV2 } from "@goat/provider-acp/server/adapter";
import { makeGrokAdapterV2 } from "@goat/provider-grok/testing";
import { GrokSettings } from "@goat/provider-grok/settings";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const memoryFixture = () =>
  packMemoryContext({
    memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: M.MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: M.MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: M.EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <instruction> 'data' \"quoted\"",
      },
    ],
  })!;

export const acpMemoryDelivery = (kind: "acp" | "grok" | "antigravity", attached: boolean) =>
  Effect.gen(function* () {
    const instanceId = M.ProviderInstanceId.make(`${kind}-memory`);
    const threadId = M.ThreadId.make(`${kind}-memory-thread`);
    const selection = { instanceId, model: kind === "antigravity" ? "gemini-test-low" : "default" };
    const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    let scopes: ReadonlyArray<M.AuthEnvironmentScope> = [];
    const presented: string[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeHttp.Server>((resolve) => {
            const fixture = NodeHttp.createServer(async (request, response) => {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
              presented.push(request.headers.authorization ?? "");
              const write = input.params?.name === "memory_upsert";
              const allowed =
                request.headers.authorization === "Bearer memory-fixture" &&
                scopes.includes("memory:read") &&
                (!write || scopes.includes("memory:write"));
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: input.id,
                  ...(allowed
                    ? { result: { content: [{ type: "text", text: "fixture result" }] } }
                    : { error: { code: -32001, message: "memory denied" } }),
                }),
              );
            });
            fixture.listen(0, "127.0.0.1", () => resolve(fixture));
          }),
      ),
      (fixture) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              fixture.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("No fixture port");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const config = (grantedScopes: ReadonlyArray<M.AuthEnvironmentScope>) => ({
      environmentId: M.EnvironmentId.make("fixture"),
      threadId,
      providerSessionId: "memory-session",
      providerInstanceId: instanceId,
      endpoint,
      authorizationHeader: "Bearer memory-fixture",
      browserToolsAvailable: false,
      grantedScopes,
    });
    if (attached)
      yield* sessions.set(config(["memory:read", "memory:write", "orchestration:read"]));
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const prompts: ReadonlyArray<{ type: string; text?: string }>[] = [];
    const launchServers: Array<
      Parameters<Parameters<typeof makeAntigravityAdapterV2>[0]["makeRuntime"]>[0]["mcpServers"]
    > = [];
    type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let connect: Parameters<Runtime["handleMcpConnect"]>[0] | undefined;
    let message: Parameters<Runtime["handleMcpMessage"]>[0] | undefined;
    const makeRuntime = (
      input: Parameters<Parameters<typeof makeAntigravityAdapterV2>[0]["makeRuntime"]>[0],
    ) =>
      Effect.gen(function* () {
        launchServers.push(input.mcpServers);
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...input,
            clientInfo: { name: "goat-test", version: "0.0.0" },
            authMethodId: "test",
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: {
                GOAT_ACP_SESSION_LIFECYCLE: "1",
                ...(kind === "antigravity" ? { GOAT_ACP_ANTIGRAVITY: "1" } : {}),
              },
            },
          }).pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
        return {
          ...runtime,
          prompt: (input) =>
            Effect.sync(() => prompts.push(input.prompt)).pipe(
              Effect.andThen(runtime.prompt(input)),
            ),
          handleMcpConnect: (handler) =>
            Effect.sync(() => {
              connect = handler;
            }).pipe(Effect.andThen(runtime.handleMcpConnect(handler))),
          handleMcpMessage: (handler) =>
            Effect.sync(() => {
              message = handler;
            }).pipe(Effect.andThen(runtime.handleMcpMessage(handler))),
        } satisfies Runtime;
      });
    const selfInvocation = yield* resolveSelfInvocation();
    const adapter =
      kind === "grok"
        ? yield* makeGrokAdapterV2({
            instanceId,
            settings: yield* Schema.decodeEffect(GrokSettings)({}),
            environment: {},
            hostPlatform: yield* HostProcess.Platform,
            selfInvocation,
            makeRuntime,
          })
        : kind === "antigravity"
          ? yield* makeAntigravityAdapterV2({
              instanceId,
              selfInvocation,
              makeRuntime,
              withProcess: (_stop, task) => task,
              defaultModel: Effect.succeed(undefined),
            })
          : yield* makeAcpAdapterV2({
              instanceId,
              selfInvocation,
              flavor: {
                driver: M.ProviderDriverKind.make("acp-test"),
                capabilities: AcpProviderCapabilitiesV2,
                makeRuntime,
              },
            });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: M.ProviderSessionId.make("memory-session"),
      modelSelection: selection,
      runtimePolicy: policy,
    });
    let thread = yield* runtime.ensureThread({
      threadId,
      modelSelection: selection,
      runtimePolicy: policy,
    });
    const now = yield* DateTime.now;
    const appThread: M.OrchestrationV2AppThread = {
      id: threadId,
      projectId: M.ProjectId.make("memory-project"),
      title: "memory fixture",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: thread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const snapshot = memoryFixture();
    const input = (ordinal: number): ProviderAdapter.ProviderAdapterV2TurnInput => ({
      appThread,
      threadId,
      providerThread: thread,
      runId: M.RunId.make(`memory-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: M.RunAttemptId.make(`memory-${ordinal}`),
      rootNodeId: M.NodeId.make(`memory-${ordinal}`),
      modelSelection: selection,
      runtimePolicy: policy,
      message: {
        messageId: M.MessageId.make(`memory-${ordinal}`),
        text: "hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      memoryContext: snapshot,
      refreshMemoryContext: () =>
        Effect.succeed(!attached || scopes.includes("memory:read") ? snapshot : undefined),
    });
    const transitions: ReadonlyArray<ReadonlyArray<M.AuthEnvironmentScope>> = [
      [],
      ["memory:read", "memory:write", "orchestration:read"],
      [],
      [],
      ["memory:read"],
      ["memory:read", "memory:write", "orchestration:read"],
    ];
    for (const [index, grant] of transitions.entries()) {
      scopes = grant;
      if (attached) yield* sessions.set(config(grant));
      if (index > 0)
        thread = yield* runtime.resumeThread({
          threadId,
          providerThread: thread,
          modelSelection: selection,
          runtimePolicy: policy,
        });
      yield* runtime.startTurn(input(index + 1));
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      const prompt = prompts.at(-1)!;
      const memory = prompt.filter((part) => part.text?.startsWith("<external_goat_memory>"));
      assert.equal(memory.length, !attached || grant.includes("memory:read") ? 1 : 0);
      if (memory.length) assert.equal(memory[0]?.text, memoryContextText(snapshot));
      const availability = prompt.find((part) => part.text?.startsWith("GOAT memory tools:"))?.text;
      if (attached && (grant.includes("memory:read") || index === 2)) {
        assert.include(availability ?? "", `read=${grant.includes("memory:read")}`);
        assert.include(availability ?? "", `write=${grant.includes("memory:write")}`);
        assert.include(availability ?? "", `source=${grant.includes("orchestration:read")}`);
      } else {
        assert.isUndefined(availability);
      }
      if (attached) {
        assert.isDefined(connect);
        assert.isDefined(message);
        const connection = yield* connect!({ serverId: "goat" }, undefined as never);
        const stdioServer = launchServers[0]?.[0];
        if (stdioServer === undefined || !("env" in stdioServer))
          return yield* Effect.die("Missing native stdio MCP attachment");
        const stdioConfig = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            env: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
          }),
        )(stdioServer);
        const stdioEndpoint = stdioConfig.env.find(
          (entry) => entry.name === "GOAT_ACP_MCP_ENDPOINT",
        )?.value;
        const stdioAuthorization = stdioConfig.env.find(
          (entry) => entry.name === "GOAT_ACP_MCP_AUTHORIZATION",
        )?.value;
        assert.equal(stdioEndpoint, endpoint);
        assert.equal(stdioAuthorization, "Bearer memory-fixture");
        for (const name of ["memory_search", "memory_upsert"]) {
          const result = yield* message!(
            {
              connectionId: connection.connectionId,
              method: "tools/call",
              params: { name, arguments: {} },
            },
            undefined as never,
          ).pipe(Effect.exit);
          assert.equal(
            Exit.isSuccess(result),
            grant.includes("memory:read") &&
              (name !== "memory_upsert" || grant.includes("memory:write")),
          );
          const stdin = new NodeStream.PassThrough();
          const written: string[] = [];
          const bridge = yield* runAcpMcpStdioBridge({
            endpoint: stdioEndpoint!,
            authorization: stdioAuthorization!,
            input: stdin,
            output: {
              write: (chunk) => {
                written.push(chunk);
              },
            },
          }).pipe(Effect.forkScoped);
          stdin.end(
            `${encodeJson({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })}\n`,
          );
          yield* Fiber.join(bridge);
          const response = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(written.join(""));
          assert.equal(
            Object.hasOwn(response, "result"),
            grant.includes("memory:read") &&
              (name !== "memory_upsert" || grant.includes("memory:write")),
          );
        }
      } else {
        assert.isDefined(connect);
        assert.isTrue(
          Exit.isFailure(
            yield* connect!({ serverId: "goat" }, undefined as never).pipe(Effect.exit),
          ),
        );
      }
    }
    if (attached) {
      scopes = [];
      yield* sessions.set(config(scopes));
      const runtimeCount = launchServers.length;
      const replacement = yield* runtime.rollbackThread({
        providerThread: thread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: M.CheckpointId.make("memory-rollback"),
          appRunOrdinal: 0,
        },
      });
      // The fixture process reuses mock-session-1; a newly created conversation
      // must reset claims even when the runtime recycles its native identifier.
      assert.equal(launchServers.length, runtimeCount + 1);
      thread = replacement.providerThread;
      yield* runtime.startTurn(input(7));
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
      );
      assert.isUndefined(
        prompts.at(-1)?.find((part) => part.text?.startsWith("GOAT memory tools:")),
      );
    }
    const before = prompts.length;
    const tampered = {
      ...snapshot,
      renderedText: snapshot.renderedText.replace("data", "tampered"),
    };
    const failed = yield* runtime
      .startTurn({ ...input(5), refreshMemoryContext: () => Effect.succeed(tampered) })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(failed));
    assert.equal(prompts.length, before);
    if (attached) {
      assert.isTrue(presented.length >= 8);
      assert.isTrue(presented.every((value) => value === "Bearer memory-fixture"));
      assert.include(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(launchServers),
        "acp-mcp-bridge",
      );
    }
    if (kind === "antigravity") assert.isUndefined(runtime.compactThread);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
