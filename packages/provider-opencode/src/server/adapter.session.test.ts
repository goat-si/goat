import { OpenCodeSettings } from "../settings.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise HTTP authentication with the real SDK.
import * as NodeHttp from "node:http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CheckpointId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { makeOpenCodeAdapterV2 } from "./adapter.ts";
import { asyncEventStream, makeOpenCodeRuntimeHarness } from "./adapter.harness.testkit.ts";

const decodeOpenCodeSettings = Schema.decodeEffect(OpenCodeSettings);

it.effect.each([false, true])(
  "OpenCode rewind forks history and validates the retained boundary, invalid=%s",
  (invalid) =>
    Effect.gen(function* () {
      const events = asyncEventStream();
      const nativeSessionId = "rewind-source";
      const forkId = "rewind-fork";
      const calls: string[] = [];
      const removed = {
        info: { id: "first-user", sessionID: nativeSessionId, role: "user", time: { created: 1 } },
        parts: [],
      };
      const harness = yield* makeOpenCodeRuntimeHarness("rewind-fork", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => events.close(), { once: true });
            return { stream: events.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          get: async ({ sessionID }: { sessionID: string }) => ({
            data: { id: sessionID, time: { created: 1, updated: 2 } },
          }),
          messages: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === nativeSessionId || invalid ? [removed] : [],
          }),
          fork: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
            assert.equal(sessionID, nativeSessionId);
            assert.equal(messageID, "first-user");
            calls.push("fork");
            return { data: { id: forkId, time: { created: 1, updated: 2 } } };
          },
          update: async () => {
            calls.push("permissions");
            return { data: {} };
          },
          revert: async () => {
            throw new Error("Native revert would change workspace files");
          },
        },
      });
      const effect = harness.runtime.rollbackThread({
        providerThread: harness.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("rewind-checkpoint"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [],
      });
      if (invalid) {
        const error = yield* effect.pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRollbackThreadError");
        assert.deepEqual(calls, ["fork"]);
      } else {
        const result = yield* effect;
        assert.equal(result.providerThread.nativeThreadRef?.nativeId, forkId);
        assert.equal(result.messages.length, 0);
        assert.deepEqual(calls, ["fork", "permissions"]);
      }
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
);

it.live.each([true, false])("opens an authenticated OpenCode session (external=%s)", (external) =>
  Effect.gen(function* () {
    const password = external ? "settings-password" : "environment-password";
    const requests: string[] = [];
    let eventConnected!: () => void;
    const eventRequest = new Promise<void>((resolve) => {
      eventConnected = resolve;
    });
    const server = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<ReturnType<typeof NodeHttp.createServer>>((resolve) => {
            const server = NodeHttp.createServer((request, response) => {
              if (
                request.headers.authorization !==
                `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
              ) {
                response.writeHead(401).end("Unauthorized");
                return;
              }
              const url = new URL(request.url!, "http://localhost");
              requests.push(url.pathname);
              if (url.pathname === "/event") {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.write(": connected\n\n");
                eventConnected();
                return;
              }
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify(
                  url.pathname.endsWith("/children")
                    ? []
                    : url.pathname === "/session"
                      ? { id: "native-auth", time: { created: 1, updated: 1 } }
                      : { healthy: true, version: "1.14.19" },
                ),
              );
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    const address = server.address();
    assert.isNotNull(address);
    if (!address || typeof address === "string") return;
    const url = `http://127.0.0.1:${address.port}`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let managedStarts = 0;
    const runtimeLayer = OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            assert.isTrue(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
            assert.include(command.args, "serve");
            assert.equal(command.options.env?.OPENCODE_SERVER_PASSWORD, password);
            managedStarts += 1;
            return spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "-e",
                  `console.log("server listening on " + process.argv[1]); setInterval(() => {}, 1000)`,
                  url,
                ],
                command.options,
              ),
            );
          }),
        ),
      ),
      Layer.provide(OpenCodeServerLedger.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const instanceId = ProviderInstanceId.make("opencode-auth");
    const adapter = yield* makeOpenCodeAdapterV2({
      instanceId,
      settings: yield* decodeOpenCodeSettings({
        serverUrl: external ? url : "",
        ...(external ? { serverPassword: password } : {}),
      }),
      environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
    }).pipe(Effect.provide(runtimeLayer));
    const session = yield* adapter.openSession({
      threadId: ThreadId.make("thread-opencode-auth"),
      providerSessionId: ProviderSessionId.make("session-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    yield* session.ensureThread({
      threadId: ThreadId.make("thread-opencode-auth"),
      modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    assert.include(requests, "/session");
    yield* Effect.promise(() => eventRequest);
    assert.include(requests, "/event");
    assert.include(requests, "/global/health");
    assert.equal(managedStarts, external ? 0 : 1);
  }).pipe(
    Effect.scoped,
    Effect.provide([
      NodeServices.layer,
      TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      IdAllocator.layer,
      McpProviderSessions.layer,
    ]),
  ),
);
