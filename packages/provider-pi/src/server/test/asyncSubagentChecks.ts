import { ProviderThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function registerPiAsyncSubagentChecks({
  makeFakePi,
  openRuntime,
  startTurn,
  THREAD_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
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
      // The run dies with the Pi process, so an idle release must wait for it.
      const otherThread = { ...providerThread, id: ProviderThreadId.make("other-provider-thread") };
      assert.isDefined(runtime.hasPendingBackgroundWork);
      assert.isDefined(runtime.hasPendingBackgroundWorkForThread);
      if (
        runtime.hasPendingBackgroundWork === undefined ||
        runtime.hasPendingBackgroundWorkForThread === undefined
      ) {
        return;
      }
      assert.isTrue(yield* runtime.hasPendingBackgroundWork);
      assert.isTrue(
        yield* runtime.hasPendingBackgroundWorkForThread(providerThread, {
          includeSubagents: true,
        }),
      );
      assert.isFalse(
        yield* runtime.hasPendingBackgroundWorkForThread(otherThread, { includeSubagents: true }),
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread(providerThread));
      // pi-subagents can mark the run settled one snapshot before the member that ran last.
      yield* emitSnapshot("failed", "running", "failed");
      yield* emitSnapshot("failed", "complete", "failed");
      assert.deepEqual(yield* collect("marker-2"), {
        statuses: ["completed", "failed"],
        pending: [false],
      });
      assert.isFalse(yield* runtime.hasPendingBackgroundWork);
      assert.isFalse(
        yield* runtime.hasPendingBackgroundWorkForThread(providerThread, {
          includeSubagents: true,
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reports that a Pi workflow continues after its coordinator fails", () =>
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
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "subagent-async",
        widgetLines: [
          `PI_SUBAGENT_ASYNC_JSON:${encodeJson({
            kind: "pi-subagents.async-status-snapshot",
            version: 1,
            runs: [
              {
                id: "wf-1",
                kind: "workflow",
                state: "running",
                children: [{ id: "alpha", kind: "step", agent: "scout", state: "running" }],
              },
            ],
          })}`,
        ],
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_wf",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "Async workflow started: wf-1" }],
          details: { mode: "workflow", runId: "wf-1", asyncId: "wf-1", results: [] },
        },
      });
      const running = yield* takeEvent((event) => event.type === "subagent.updated");
      assert.isTrue(running.type === "subagent.updated" && running.subagent.status === "running");

      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Rate limited" },
      });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.childTurnsContinue === true,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
