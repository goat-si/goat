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
  openRuntime,
  startTurn,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
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
}
