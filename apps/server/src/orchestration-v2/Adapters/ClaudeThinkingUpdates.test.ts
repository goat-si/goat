import { assert, describe, it } from "@effect/vitest";
import { RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import {
  claudeSdkFrame,
  makeResultFrame,
  WAKE_NATIVE_SESSION,
} from "./ClaudeWakeFrames.testkit.ts";
const makeWakeHarness = makeWakeHarnessWithOptions();
describe("Claude thinking updates", () => {
  // Default display sends the first pre-tool thinking block empty; a blank update is never promoted.
  const update = "Found it: the memory file is the cause.";
  it.effect.each([
    {
      model: "claude-opus-5-5",
      texts: ["", update],
      expected: ["assistant_message"],
      shown: [update],
    },
    { model: "claude-opus-5", texts: ["", update], expected: ["reasoning"], shown: [update] },
    {
      model: "claude-opus-5-5",
      texts: ["Planning the check", " \n "],
      expected: ["reasoning", "reasoning"],
    },
  ] as ReadonlyArray<{
    readonly model: string;
    readonly texts: ReadonlyArray<string>;
    readonly expected: ReadonlyArray<string>;
    readonly shown?: ReadonlyArray<string>;
  }>)(
    "shows $model thinking $texts before a tool call as $expected",
    ({ model, texts, expected, shown }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`thinking-before-tool-${model}`),
            text: "Check the file",
            attachments: [],
          }),
        );
        const snapshot = (uuid: string, content: ReadonlyArray<Record<string, unknown>>) =>
          claudeSdkFrame({
            type: "assistant",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
            parent_tool_use_id: null,
            message: { id: "reply-message", model, content },
          });
        const frames = [
          ...texts.map((thinking, index) =>
            snapshot(`thinking-snapshot-${index}`, [
              { type: "thinking", thinking, signature: "sig" },
            ]),
          ),
          snapshot("tool-snapshot", [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } },
          ]),
          makeResultFrame({ uuid: "tool-result", result: "" }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        yield* Queue.take(harness.terminalReceipts);
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "reasoning" || event.turnItem.type === "assistant_message")
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        const items = [...latest.values()];
        assert.deepEqual(
          items.map((item) => item.type),
          [...expected],
        );
        assert.deepEqual(
          items.map((item) => item.text),
          [...(shown ?? texts)],
        );
      }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
  );
});
