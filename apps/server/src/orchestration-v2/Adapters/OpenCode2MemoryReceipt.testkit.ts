import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import { memoryFixture } from "./memoryDelivery.testkit.ts";
import {
  SESSION,
  event,
  out,
  promptAccepted,
  reply,
  replyData,
  providerThread,
  resumed,
  terminalOf,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

export const testInboxMemoryDelivery = (pauseDuringInstructionWrite = false) =>
  Effect.gen(function* () {
    const gate = makeProviderReplayGate(["deliver-memory"]);
    const attempt = turnInput(providerThread(yield* DateTime.now)).attemptId;
    const inboxID = `msg_t3_turn_${SESSION}:${attempt}`;
    let allowed = true;
    const values: string[] = [];
    const { runtime, thread } = yield* resumed(
      [
        out("session.prompt", { sessionID: SESSION, text: "hi" }),
        promptAccepted,
        event("session.inbox.delivered", { sessionID: SESSION, inboxID }, "deliver-memory"),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ],
      {
        replayGate: gate,
        memoryInstructions: (value) => {
          values.push(value);
          if (pauseDuringInstructionWrite) allowed = false;
          return new Response(null, { status: 204 });
        },
      },
    );
    const delivered: Array<unknown> = [];
    const uncertain: Array<unknown> = [];
    const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
    yield* runtime.startTurn({
      ...turnInput(thread),
      memoryContext: memoryFixture(),
      canDeliverMemory: () => Effect.sync(() => allowed),
      onMemoryDelivered: (snapshot) =>
        Effect.sync(() => {
          delivered.push(snapshot);
        }),
      onMemoryDeliveryUncertain: (snapshot) =>
        Effect.sync(() => {
          uncertain.push(snapshot);
        }),
    });
    assert.isTrue(yield* Effect.promise(() => gate.waitForReached("deliver-memory")));
    assert.isEmpty(delivered);
    assert.lengthOf(uncertain, 1);
    gate.release("deliver-memory");
    yield* Fiber.join(terminal);
    assert.lengthOf(delivered, pauseDuringInstructionWrite ? 0 : 1);
    assert.equal(values.length, pauseDuringInstructionWrite ? 2 : 1);
    if (pauseDuringInstructionWrite) assert.equal(values[1], "");
  }).pipe(Effect.scoped);

export const testCommandMemoryDelivery = () =>
  Effect.gen(function* () {
    const gate = makeProviderReplayGate(["command-execution"]);
    const { runtime, thread } = yield* resumed(
      [
        out("command.list", "<any>"),
        reply("command.list", {
          location: { directory: "/work/opencode2" },
          data: [{ name: "git/hello" }],
        }),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
        reply("message.list", { data: [], cursor: {} }),
        out("session.command", { sessionID: SESSION, name: "git/hello", text: "WORLD" }),
        reply("session.command", null),
        // The command runs the model, so the idle-command probe finds the session running.
        out("session.active"),
        replyData("session.active", { [SESSION]: { type: "running" } }),
        event("session.execution.succeeded", { sessionID: SESSION }, "command-execution"),
      ],
      { replayGate: gate, memoryInstructions: () => new Response(null, { status: 204 }) },
    );
    const delivered: Array<unknown> = [];
    const uncertain: Array<unknown> = [];
    const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
    const input = turnInput(thread);
    yield* runtime.startTurn({
      ...input,
      message: { ...input.message, text: "/git/hello WORLD" },
      memoryContext: memoryFixture(),
      onMemoryDelivered: (snapshot) =>
        Effect.sync(() => {
          delivered.push(snapshot);
        }),
      onMemoryDeliveryUncertain: (snapshot: unknown) =>
        Effect.sync(() => {
          uncertain.push(snapshot);
        }),
    });
    assert.isTrue(yield* Effect.promise(() => gate.waitForReached("command-execution")));
    assert.isEmpty(delivered);
    assert.lengthOf(uncertain, 1);
    gate.release("command-execution");
    yield* Fiber.join(terminal);
  }).pipe(Effect.scoped);
