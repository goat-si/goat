import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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
import {
  asyncEventStream,
  makeOpenCodeRuntimeHarness,
  promiseGate,
} from "./adapter.harness.testkit.ts";

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

it.effect.each([
  "idle",
  "stop",
  "error-before-launch",
  "resume",
  "resume-busy-before-link",
  "outcome-capacity",
  "overflow",
  "large-output",
  "capacity",
  "capacity-error",
] as const)("keeps a detached task running until child %s", (ending) =>
  Effect.gen(function* () {
    const nativeEvents = asyncEventStream();
    const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
    const root = "ses_root";
    const child = "ses_child";
    const resumed = ending === "resume" || ending === "resume-busy-before-link";
    let promptId = "";
    const abortStarted = promiseGate<void>();
    const releaseAbort = promiseGate<void>();
    const harness = yield* makeOpenCodeRuntimeHarness("background-child", root, {
      event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
      session: {
        create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: { id: sessionID, parentID: root, permission: [], time: { created: 2, updated: 2 } },
        }),
        update: async () => ({ data: { id: child, parentID: root } }),
        promptAsync: async (input: { messageID: string }) => {
          promptId = input.messageID;
          return { data: true };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === child && ending === "stop") {
            abortStarted.resolve();
            await releaseAbort.promise;
          }
          return { data: true };
        },
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === root ? [{ id: child }] : [],
        }),
      },
    });
    const hasPendingBackgroundWork = harness.runtime.hasPendingBackgroundWork;
    if (hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("OpenCode runtime must expose hasPendingBackgroundWork.");
    }
    yield* harness.startTurn();
    const terminal = yield* harness.runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const launchOutput = ending === "large-output" ? "🚀".repeat(2048) : "Background task started";
    const taskPart = (
      status: "running" | "completed",
      childId = child,
      mode: "detached" | "foreground" | "resume" = "detached",
    ) => ({
      type: "message.part.updated",
      properties: {
        sessionID: root,
        part: {
          id: `prt_task_${childId}${mode === "resume" ? "_resumed" : ""}`,
          sessionID: root,
          messageID: "msg_root_assistant",
          type: "tool",
          tool: "task",
          callID: "call_task",
          state: {
            status,
            input: {
              description: "Background sleep task",
              prompt: "sleep",
              subagent_type: "general",
              ...(mode === "resume" ? { task_id: childId } : {}),
            },
            title: "Background sleep task",
            metadata: {
              parentSessionId: root,
              sessionId: childId,
              background: mode !== "foreground",
            },
            time: { start: 3, ...(status === "completed" ? { end: 3 } : {}) },
            ...(status === "completed" ? { output: launchOutput } : {}),
          },
        },
      },
    });
    const status = (sessionID: string, type: "busy" | "idle") => ({
      type: "session.status",
      properties: { sessionID, status: { type } },
    });

    yield* push({
      type: "message.updated",
      properties: {
        sessionID: root,
        info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
      },
    });
    yield* push(status(root, "busy"));
    const created = (id: string) => ({
      type: "session.created",
      properties: { sessionID: id, info: { id, parentID: root, time: { created: 2, updated: 2 } } },
    });
    const childError = (name: string, id = child) => ({
      type: "session.error",
      properties: { sessionID: id, error: { name, data: { message: "Child failed" } } },
    });
    if (ending === "outcome-capacity") {
      yield* push(childError("UnknownError"));
      for (let index = 0; index < 1024; index++) {
        yield* push(childError("UnknownError", `unbound-${index}`));
      }
    } else {
      yield* push(taskPart("running", child, resumed ? "foreground" : "detached"));
      yield* push(created(child));
      if (ending === "error-before-launch") yield* push(childError("UnknownError"));
      if (resumed) {
        yield* push(status(child, "busy"));
        yield* push(status(child, "idle"));
        yield* push(taskPart("completed", child, "foreground"));
        if (ending === "resume-busy-before-link") yield* push(status(child, "busy"));
        yield* push(taskPart("running", child, "resume"));
        if (ending === "resume") yield* push(status(child, "busy"));
      }
    }
    yield* push(taskPart("completed", child, resumed ? "resume" : "detached"));
    if (ending === "resume-busy-before-link") yield* push(childError("UnknownError"));
    if (ending === "capacity" || ending === "capacity-error") {
      for (let index = 0; index < 128; index++) {
        const id = `ses_child_${index}`;
        yield* push(created(id));
        yield* push(taskPart("completed", id));
      }
    }
    yield* push(status(root, "idle"));
    const rootEvents = yield* Fiber.join(terminal);
    const rootTerminal = rootEvents.find((event) => event.type === "turn.terminal");
    assert.equal(rootTerminal?.status, "completed");
    if (ending === "capacity" || ending === "capacity-error") {
      const projected = new Map(
        rootEvents.flatMap((event) =>
          event.type === "subagent.updated" ? [[event.subagent.id, event.subagent] as const] : [],
        ),
      );
      const oldest = projected.values().next().value;
      assert.deepEqual(
        [...projected.values()].map(({ status }) => status),
        ["idle", ...Array(128).fill("running")],
      );
      assert.equal(oldest?.result, "Tracking lost. Outcome unknown.");
      if (oldest === undefined) return yield* Effect.die("The evicted card was not projected.");
      if (ending === "capacity-error") yield* push(childError("UnknownError"));
      else yield* push(status(child, "idle"));
      nativeEvents.close();
      const late = yield* harness.runtime.events.pipe(Stream.runCollect);
      const confirmed = late.find(
        (event) => event.type === "subagent.updated" && event.subagent.id === oldest.id,
      );
      assert.equal(
        confirmed?.type === "subagent.updated" ? confirmed.subagent.status : undefined,
        ending === "capacity-error" ? "failed" : "completed",
      );
      return;
    }
    if (ending === "outcome-capacity" || resumed) {
      const projected = rootEvents.filter((event) => event.type === "subagent.updated");
      assert.deepEqual(
        projected.map((event) => event.subagent.status),
        resumed
          ? [
              "running",
              "completed",
              "running",
              "running",
              ...(ending === "resume-busy-before-link" ? ["failed"] : []),
            ]
          : ["idle"],
      );
      if (ending === "outcome-capacity") {
        assert.equal(projected.at(-1)?.subagent.result, "Tracking lost. Outcome unknown.");
        yield* push(status(child, "idle"));
        nativeEvents.close();
        const late = yield* harness.runtime.events.pipe(Stream.runCollect);
        assert.isFalse(late.some((event) => event.type === "subagent.updated"));
      }
      return;
    }
    assert.deepEqual(
      rootEvents.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent.status] : [],
      ),
      ["running", ending === "error-before-launch" ? "failed" : "running"],
    );
    const result = rootEvents.findLast((event) => event.type === "subagent.updated")?.subagent
      .result;
    if (ending === "large-output") assert.equal(result, "🚀".repeat(1023) + "…");
    if (ending === "error-before-launch") {
      yield* push(status(child, "idle"));
      assert.isFalse(yield* hasPendingBackgroundWork);
      return;
    }
    assert.isTrue(yield* hasPendingBackgroundWork, "the running child must pin idle release");

    const finished = yield* harness.runtime.events.pipe(
      Stream.filter((event) => event.type === "subagent.updated"),
      Stream.runHead,
      Effect.forkScoped,
    );
    if (ending === "stop" && rootTerminal !== undefined) {
      const stop = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: rootTerminal.providerTurnId,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => abortStarted.promise);
      yield* push({ type: "session.idle", properties: { sessionID: child } });
      releaseAbort.resolve();
      yield* Fiber.join(stop);
    } else {
      if (ending === "overflow") {
        yield* push({
          type: "message.updated",
          properties: {
            sessionID: child,
            info: { id: "child-prompt", role: "user", time: { created: 2 } },
          },
        });
      }
      yield* push(status(child, "busy"));
      if (ending === "overflow") yield* push(childError("ContextOverflowError"));
      yield* push(status(child, "idle"));
    }
    assert.isFalse(yield* hasPendingBackgroundWork, "an idle child must not pin idle release");
    const childEvent = Option.getOrUndefined(yield* Fiber.join(finished));
    if (ending === "large-output" && childEvent?.type === "subagent.updated") {
      assert.equal(childEvent.subagent.result, result);
    }
    assert.equal(
      childEvent?.type === "subagent.updated" ? childEvent.subagent.status : null,
      ending === "stop" ? "interrupted" : ending === "overflow" ? "failed" : "completed",
    );
  }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)), Effect.scoped),
);
