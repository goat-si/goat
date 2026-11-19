import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as FileSystem from "effect/FileSystem";
import { PI_PROVIDER } from "../adapter.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function registerPiToolChecks({
  makeFakePi,
  makeAdapter,
  openRuntime,
  startTurn,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  makeAdapter: typeof Fixture.makeAdapter;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  SESSION_ID: typeof Fixture.SESSION_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("nests tools called through another tool under their caller", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const takeToolEvents = Effect.fnUntraced(function* (toolCallId: string) {
        const node = yield* takeEvent(
          (event) =>
            event.type === "node.updated" && event.node.nativeItemRef?.nativeId === toolCallId,
        );
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        if (node.type !== "node.updated" || item.type !== "turn_item.updated")
          return yield* Effect.die("Expected tool node and item events");
        return { node: node.node, item: item.turnItem };
      });

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_code",
        toolName: "codemode",
        args: { code: "await read({ path: 'a.ts' })" },
      });
      const caller = yield* takeToolEvents("call_code");
      assert.equal(caller.node.parentNodeId, caller.node.rootNodeId);
      assert.isNull(caller.item.parentItemId);

      // Pi tags every phase, so an update that arrives before its start still nests.
      const phases = [
        { type: "tool_execution_update", partialResult: { content: [] }, status: "running" },
        { type: "tool_execution_start", args: { path: "a.ts" }, status: "running" },
        {
          type: "tool_execution_end",
          isError: true,
          result: { content: [{ type: "text", text: "ENOENT" }] },
          status: "failed",
        },
      ] as const;
      for (const { status, ...phase } of phases) {
        yield* fake.emit({
          ...phase,
          toolCallId: "call_code/1",
          toolName: "read",
          parentToolCallId: "call_code",
        });
        const nested = yield* takeToolEvents("call_code/1");
        assert.equal(nested.node.status, status);
        assert.equal(nested.node.parentNodeId, caller.node.id);
        assert.equal(nested.item.parentItemId, caller.item.id);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("emits only new shell output from repeated Pi snapshots", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "shell-delta",
        toolName: "bash",
        args: { command: "echo hello" },
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
      );
      for (const [text, totalBytes, expected] of [
        ["hel", undefined, "hel"],
        ["hello", undefined, "lo"],
        ["lo\n\u00e9!", 9, "\n\u00e9!"],
      ] as const) {
        yield* fake.emit({
          type: "tool_execution_update",
          toolCallId: "shell-delta",
          toolName: "bash",
          partialResult: {
            content: [{ type: "text", text }],
            ...(totalBytes === undefined ? {} : { details: { truncation: { totalBytes } } }),
          },
        });
        const event = yield* takeEvent(
          (event) =>
            event.type === "command_output.delta" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "command_execution"),
        );
        assert.equal(event.type, "command_output.delta");
        if (event.type === "command_output.delta") assert.equal(event.chunk, expected);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("classifies Pi notifications and keeps unknown notices at the legacy default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      for (const [notifyType, severity] of [
        ["info", "info"],
        ["warning", "warning"],
        ["error", "warning"],
        ["other", undefined],
        [undefined, undefined],
      ] as const) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "notice",
          ...(notifyType === undefined ? {} : { notifyType }),
        });
        const event = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "system_notice")
          return yield* Effect.die("Expected notice");
        assert.equal(event.turnItem.severity, severity);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("forks resumed sessions from another cwd into the runtime cwd", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/old.jsonl`;
      yield* fs.writeFileString(
        file,
        `${encodeJson({ type: "session", version: 3, id: "s", cwd: `${host.paths.cwd}-old` })}\n{}\n`,
      );
      const forkFile = "/fake/forked-into-worktree.jsonl";
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: "/fake/other-session.jsonl" });
      fake.queueState({ sessionFile: forkFile });
      const resumed = yield* runtime.resumeThread({
        providerThread: {
          ...thread,
          nativeThreadRef: { driver: PI_PROVIDER, nativeId: file, strength: "strong" },
        },
      });
      assert.equal(forkFake.lastSpawn().args.at(-1), file);
      assert.equal(
        fake.allRequests().findLast((request) => request.type === "switch_session")?.sessionPath,
        forkFile,
      );
      assert.equal(resumed.nativeThreadRef?.nativeId, forkFile);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("shows the members of an async pi-subagents workflow as running subagents", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      // Frames as pi-subagents 0.88.1 sends them for an async `runs.all([alpha, beta])` workflow.
      const step = (key: string, state: string) => ({
        id: key,
        kind: "step",
        label: key,
        state,
        startedAt: 1_000,
        updatedAt: 2_000,
        activity: { currentTool: "bash", turnCount: 1, toolCount: 1 },
        agent: "scout",
        model: "anthropic/claude-haiku-5-5",
      });
      const emitSnapshot = (state: string, alpha: string, beta: string) =>
        fake.emit({
          type: "extension_ui_request",
          id: `widget-${state}`,
          method: "setWidget",
          widgetKey: "subagent-async",
          widgetLines: [
            `PI_SUBAGENT_ASYNC_JSON:${encodeJson({
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              generatedAt: 2_000,
              runs: [
                {
                  id: "wf-1",
                  kind: "workflow",
                  label: "scout, scout",
                  state,
                  startedAt: 1_000,
                  updatedAt: 2_000,
                  children: [step("alpha", alpha), step("beta", beta)],
                },
              ],
            })}`,
          ],
        });
      const collect = Effect.fnUntraced(function* (marker: string) {
        yield* fake.emit({
          type: "tool_execution_end",
          toolCallId: marker,
          toolName: marker,
          result: { content: [{ type: "text", text: "after" }] },
        });
        const statuses = new Map<string, string>();
        const pending: Array<boolean> = [];
        while (true) {
          const event = yield* takeEvent(
            (event) =>
              event.type === "subagent.updated" ||
              event.type === "background_work.updated" ||
              (event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.toolName === marker),
          );
          if (event.type === "background_work.updated") pending.push(event.pending);
          else if (event.type === "subagent.updated")
            statuses.set(event.subagent.id, event.subagent.status);
          else break;
        }
        return { statuses: [...statuses.values()].toSorted(), pending };
      });
      // The launch snapshot precedes the tool result that names the run.
      yield* emitSnapshot("running", "running", "running");
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_wf",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "Async workflow started: wf-1" }],
          details: {
            mode: "workflow",
            runId: "wf-1",
            asyncId: "wf-1",
            results: [],
            workflowChildren: {
              version: 1,
              parentToolCallId: "call_wf",
              workflowRunId: "wf-1",
              inventoryComplete: false,
              workflowState: "running",
              children: [],
            },
          },
        },
      });
      assert.deepEqual(yield* collect("marker-1"), {
        statuses: ["running", "running"],
        pending: [true],
      });
      yield* emitSnapshot("failed", "complete", "failed");
      assert.deepEqual(yield* collect("marker-2"), {
        statuses: ["completed", "failed"],
        pending: [false],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("attaches an initial session at startup without a redundant extension reload", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: prior } = yield* openRuntime(source);
      const existing = yield* prior.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const fake = yield* makeFakePi;
      const session = "/fake/attached.jsonl";
      fake.queueState({ sessionFile: session });
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: session,
      });
      assert.include(fake.lastSpawn().args, "--session");
      assert.include(fake.lastSpawn().args, session);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: {
          ...existing,
          nativeThreadRef: { driver: PI_PROVIDER, nativeId: session, strength: "strong" },
        },
      });
      assert.equal(thread.nativeThreadRef?.nativeId, session);
      assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("keeps a resumed session already attached to the same file", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ sessionFile: thread.nativeThreadRef?.nativeId });
      yield* runtime.resumeThread({ providerThread: thread });
      assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("reserves the session while same-file registration reads state", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.takeRequest("get_state");
      fake.deferNextState();
      const registration = yield* runtime
        .resumeThread({ providerThread: thread })
        .pipe(Effect.forkChild);
      yield* fake.takeRequest("get_state");
      const overlapping = yield* startTurn(runtime, thread).pipe(Effect.result);
      assert.equal(overlapping._tag, "Failure");
      yield* fake.resolveDeferredState({ sessionFile: thread.nativeThreadRef?.nativeId });
      yield* Fiber.join(registration);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("recovers when a startup attachment exits before Pi accepts requests", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: original } = yield* openRuntime(source);
      const thread = yield* original.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const failed = yield* makeFakePi;
      const replacement = yield* makeFakePi;
      let count = 0;
      const fake = {
        ...replacement,
        spawner: ChildProcessSpawner.make((command) => {
          count += 1;
          return count === 1 ? failed.spawner.spawn(command) : replacement.spawner.spawn(command);
        }),
      };
      yield* failed.closeStdout;
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
      });
      const resumed = yield* runtime.resumeThread({ providerThread: thread }).pipe(Effect.result);
      assert.equal(resumed._tag, "Success");
      assert.equal(count, 2);
      assert.notInclude(replacement.lastSpawn().args, "--session");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("buffers native work arriving before the attached session is registered", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: prior } = yield* openRuntime(source);
      const thread = yield* prior.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const fake = yield* makeFakePi;
      fake.queueState({ sessionFile: thread.nativeThreadRef!.nativeId });
      const offers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const adapter = yield* makeAdapter(fake, "", undefined, {
        offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
      });
      const observed = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(observed, event)),
        Effect.forkScoped,
      );
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "barrier",
        statusText: "ready",
      });
      const event = yield* Queue.take(observed);
      assert.isFalse(
        event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      yield* runtime.resumeThread({ providerThread: thread });
      const offer = yield* Queue.take(offers);
      assert.equal(offer.threadId, THREAD_ID);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "does not replace an attached session while its early native work awaits ownership",
    () =>
      Effect.gen(function* () {
        const source = yield* makeFakePi;
        const { runtime: prior } = yield* openRuntime(source);
        const thread = yield* prior.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const fake = yield* makeFakePi;
        fake.queueState({ sessionFile: thread.nativeThreadRef!.nativeId });
        const adapter = yield* makeAdapter(fake);
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
          initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
        });
        const observed = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(observed, event)),
          Effect.forkScoped,
        );
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "barrier",
          statusText: "ready",
        });
        yield* Queue.take(observed);
        const other = {
          ...thread,
          nativeThreadRef: { ...thread.nativeThreadRef!, nativeId: "/fake/other.jsonl" },
        };
        const result = yield* runtime.resumeThread({ providerThread: other }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("passes the GOAT thread identity to Pi without an MCP session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      assert.equal(fake.lastSpawn().env.GOAT_THREAD_ID, THREAD_ID);
      assert.equal(fake.lastSpawn().env.T3CODE_THREAD_ID, THREAD_ID);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("attaches image preview paths to completed Pi reads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, thread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "read-image",
        toolName: "read",
        args: { path: "/workspace/shot.png" },
        result: { content: [{ type: "text", text: "image" }] },
      });
      const event = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
        return yield* Effect.die("Expected read item");
      assert.equal(event.turnItem.viewedImagePath, "/workspace/shot.png");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect.each(["settled", "abort", "runtime restart"] as const)(
    "retains the live session after extension handoff (%s)",
    (mode) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, thread);
        yield* fake.takeRequest("prompt");
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated") return yield* Effect.die("Expected turn");
        yield* fake.emit({ type: "agent_start" });
        if (mode !== "settled") {
          fake.queueState({ sessionFile: "/fake/extension-child.jsonl" });
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: running.providerTurn.id,
            requestRuntimeRestart: mode === "runtime restart",
          });
        } else fake.queueState({ sessionFile: "/fake/extension-child.jsonl" });
        if (mode !== "runtime restart")
          yield* fake.emit({ type: "agent_settled", aborted: mode === "abort" });
        const idle = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        if (idle.type !== "provider_thread.updated") return yield* Effect.die("Expected thread");
        assert.equal(idle.providerThread.nativeThreadRef?.nativeId, "/fake/extension-child.jsonl");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
