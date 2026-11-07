import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  testLayer,
  INSTANCE_ID,
  THREAD_ID,
  runtimePolicy,
  modelSelection,
  makeFakeMuse,
  makeHarness,
  turnInput,
} from "./test/adapterHelpers.ts";

describe("MuseAdapterV2", () => {
  it.effect.each([true, false])(
    "forceNewNativeThread starts a distinct session preserving row identity with existing row %s",
    (includeExisting) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
        const original = harness.providerThread;
        const fresh = yield* harness.runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          ...(includeExisting ? { existingProviderThread: original } : {}),
          forceNewNativeThread: true,
        });
        assert.notStrictEqual(fresh.nativeThreadRef?.nativeId, original.nativeThreadRef?.nativeId);
        assert.strictEqual(fresh.id, original.id);
        assert.strictEqual(fresh.createdAt, original.createdAt);
        assert.strictEqual(fresh.appThreadId, original.appThreadId);
        assert.strictEqual(fresh.providerSessionId, original.providerSessionId);
        assert.strictEqual(fresh.status, "idle");
        const starts = fake.calls.filter((call) => call.method === "session/start");
        assert.strictEqual(starts.length, 1);
        assert.strictEqual(starts[0]?.params.sessionId, fresh.nativeThreadRef?.nativeId);
        assert.strictEqual(fake.calls.filter((call) => call.method === "session/resume").length, 1);
        const again = yield* harness.runtime.resumeThread!({ providerThread: fresh });
        assert.strictEqual(again.id, fresh.id);
        assert.strictEqual(again.nativeThreadRef?.nativeId, fresh.nativeThreadRef?.nativeId);
        yield* harness.runtime.startTurn(yield* turnInput(fresh));
        const started = yield* fake.takeCall("turn/start");
        assert.strictEqual(started.params.sessionId, fresh.nativeThreadRef?.nativeId);
        yield* fake.emit("turn/completed", { turnId: started.commandId, terminal: "completed" });
        assert.strictEqual(
          (yield* harness.takeEvent("turn.terminal")).providerThreadId,
          original.id,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
