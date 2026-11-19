import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";

export function registerPiToolChecks({
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
}
