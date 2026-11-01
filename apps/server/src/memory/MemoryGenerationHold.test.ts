import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";

import * as Hold from "./MemoryGenerationHold.ts";

const rejected = new M.TextGenerationError({
  operation: "generateMemorySummary",
  detail:
    'Codex CLI command failed: {"error":{"message":"Invalid schema for response_format","code":"invalid_json_schema"},"status":400}',
});
const flaky = new M.TextGenerationError({
  operation: "generateMemorySummary",
  detail: "Codex returned invalid structured output.",
});

describe("MemoryGenerationHold", () => {
  it.effect("probes after 1 minute, 10 minutes and 1 hour, then once a day", () =>
    Effect.gen(function* () {
      const hold = yield* Hold.make;
      let calls = 0;
      const call = Effect.suspend(() => {
        calls += 1;
        return Effect.fail(rejected);
      });
      const attempt = hold.guard("model@1", call).pipe(Effect.flip);
      assert.strictEqual((yield* attempt)._tag, "TextGenerationError");
      for (const [wait, expected] of [
        [59_999, 1],
        [1, 2],
        [599_999, 2],
        [1, 3],
        [3_599_999, 3],
        [1, 4],
        [86_399_999, 4],
        [1, 5],
      ] as const) {
        yield* TestClock.adjust(wait);
        yield* attempt;
        assert.strictEqual(calls, expected, `after +${wait}ms`);
      }
      const status = yield* hold.status("model@1");
      assert.strictEqual(status?.reason, "schema_rejected");
      assert.isTrue(yield* hold.isHeld("model@1"));
      // Another model or provider version is not held.
      assert.isFalse(yield* hold.isHeld("model@2"));
    }),
  );

  it.effect("lets one probe through at a time and releases it when the probe is interrupted", () =>
    Effect.gen(function* () {
      const hold = yield* Hold.make;
      yield* hold.guard("model", Effect.fail(rejected)).pipe(Effect.flip);
      yield* TestClock.adjust(60_000);
      const started = yield* Deferred.make<void>();
      const probe = yield* hold
        .guard("model", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* hold.guard("model", Effect.succeed("ran")).pipe(Effect.flip);
      assert.strictEqual(second._tag, "MemoryGenerationHeld");
      yield* Fiber.interrupt(probe);
      // The interrupted probe gave its slot back; the hold is still due.
      assert.strictEqual(yield* hold.guard("model", Effect.succeed("ran")), "ran");
      assert.isFalse(yield* hold.isHeld("model"));
    }),
  );

  it.effect("clears on success and on an answer that is not a repeatable rejection", () =>
    Effect.gen(function* () {
      const hold = yield* Hold.make;
      yield* hold.guard("a", Effect.fail(rejected)).pipe(Effect.flip);
      yield* hold.guard("b", Effect.fail(rejected)).pipe(Effect.flip);
      yield* TestClock.adjust(60_000);
      yield* hold.guard("a", Effect.succeed(1));
      yield* hold.guard("b", Effect.fail(flaky)).pipe(Effect.flip);
      assert.isUndefined(yield* hold.status("a"));
      assert.isUndefined(yield* hold.status("b"));
      // A flaky answer never opens a hold.
      yield* hold.guard("c", Effect.fail(flaky)).pipe(Effect.flip);
      assert.isFalse(yield* hold.isHeld("c"));
    }),
  );

  it.effect("probes a throttled model at least hourly", () =>
    Effect.gen(function* () {
      const hold = yield* Hold.make;
      const throttled = new M.TextGenerationError({
        operation: "generateMemorySummary",
        detail: 'Codex CLI command failed: {"status":429}',
      });
      assert.strictEqual(Hold.deterministicFailure(throttled), "rate_limited");
      const attempt = hold.guard("model", Effect.fail(throttled)).pipe(Effect.flip);
      yield* attempt;
      for (const wait of [60_000, 600_000, 3_600_000, 3_600_000]) {
        yield* TestClock.adjust(wait);
        yield* attempt;
      }
      // Throttling usually clears on its own: the fifth failure waits an hour, not a day.
      assert.strictEqual(
        Date.parse((yield* hold.status("model"))!.nextAttemptAt) -
          Date.parse((yield* hold.status("model"))!.since),
        60_000 + 600_000 + 3_600_000 + 3_600_000 + 3_600_000,
      );
    }),
  );

  it.effect("keys a selection by its typed, unordered options", () =>
    Effect.gen(function* () {
      const hold = yield* Hold.make;
      const base = { instanceId: M.ProviderInstanceId.make("codex"), model: "luna" };
      const key = (options?: M.MemoryModelSelection["options"]) =>
        hold.keyFor(M.MemoryModelSelection.make({ ...base, ...(options ? { options } : {}) }));
      assert.strictEqual(yield* key(), yield* key([]));
      assert.strictEqual(
        yield* key([
          { id: "a", value: "1" },
          { id: "b", value: true },
        ]),
        yield* key([
          { id: "b", value: true },
          { id: "a", value: "1" },
        ]),
      );
      assert.notStrictEqual(
        yield* key([{ id: "flag", value: true }]),
        yield* key([{ id: "flag", value: "true" }]),
      );
    }),
  );

  it("treats only rejections that repeat for every request as deterministic", () => {
    assert.strictEqual(Hold.deterministicFailure(rejected), "schema_rejected");
    assert.strictEqual(
      Hold.deterministicFailure({ cause: { cause: rejected } }),
      "schema_rejected",
    );
    assert.isUndefined(Hold.deterministicFailure(flaky));
    // Grok, OpenCode and Claude isolation report a missing model under a free-text detail.
    const runner = (code: MemoryGenerationRunnerError["code"]) =>
      new M.TextGenerationError({
        operation: "generateMemorySummary",
        detail: "Grok did not disclose or support the selected memory model.",
        cause: new MemoryGenerationRunnerError({ code }),
      });
    assert.strictEqual(Hold.deterministicFailure(runner("unavailable")), "unavailable");
    assert.strictEqual(Hold.deterministicFailure(runner("identity_mismatch")), "unavailable");
    assert.strictEqual(
      Hold.deterministicFailure({ cause: runner("unsupported_operation") }),
      "unavailable",
    );
    assert.isUndefined(Hold.deterministicFailure(runner("invalid_output")));
    // Cursor, Antigravity and managed Codex keep the provider's setup error as the cause.
    const setup = (detail: string) =>
      new M.TextGenerationError({
        operation: "generateMemorySummary",
        detail: "Cursor SDK text generation failed.",
        cause: new M.ProviderSetupError({
          instanceId: M.ProviderInstanceId.make("cursor"),
          operation: "requireApiKey",
          detail,
        }),
      });
    assert.strictEqual(
      Hold.deterministicFailure(
        setup("Sign in with Cursor or add CURSOR_API_KEY in provider settings."),
      ),
      "auth",
    );
    assert.strictEqual(
      Hold.deterministicFailure(setup("Antigravity needs a Gemini API key.")),
      "unavailable",
    );
    assert.strictEqual(
      Hold.deterministicFailure(
        new M.TextGenerationError({ operation: "x", detail: "Codex CLI request timed out." }),
      ),
      undefined,
    );
  });
});
