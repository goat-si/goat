import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { CodexAppServerClient } from "./client.ts";
import { layerReplayWithDriver, makeReplayDriver } from "./replay.ts";

it.effect.each(["t3_code_", "goat_code_"])(
  "replays %s development context against recordings without the discipline",
  (prefix) =>
    Effect.gen(function* () {
      const driver = yield* makeReplayDriver({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "context-compatibility",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              id: 1,
              method: "turn/start",
              params: {
                threadId: "thread-1",
                additionalContext: {
                  project: { kind: "application", value: "Keep this context" },
                  t3_code_runtime: { kind: "application", value: "runtime" },
                },
              },
            },
          },
          { type: "emit_inbound", frame: { id: 1, result: {} } },
        ],
      });
      const result = yield* Effect.gen(function* () {
        const client = yield* CodexAppServerClient;
        return yield* client.raw.request("turn/start", {
          threadId: "thread-1",
          additionalContext: {
            [`${prefix}development`]: { kind: "application", value: "Current discipline" },
            goat_code_runtime: { kind: "application", value: "runtime" },
            project: { kind: "application", value: "Keep this context" },
          },
        });
      }).pipe(Effect.provide(layerReplayWithDriver(driver)), Effect.scoped);
      assert.deepEqual(result, {});
      assert.deepEqual(yield* Ref.get(driver.state), { cursor: 2, failure: null });
    }),
);

it.effect("strips both development keys when they are the only context entries", () =>
  Effect.gen(function* () {
    const driver = yield* makeReplayDriver({
      provider: "codex",
      protocol: "codex.app-server",
      version: "test",
      scenario: "context-only-discipline",
      entries: [
        { type: "expect_outbound", frame: { id: 1, method: "turn/start", params: {} } },
        { type: "emit_inbound", frame: { id: 1, result: {} } },
      ],
    });
    yield* Effect.gen(function* () {
      const client = yield* CodexAppServerClient;
      yield* client.raw.request("turn/start", {
        additionalContext: {
          t3_code_development: { kind: "application", value: "Old" },
          goat_code_development: { kind: "application", value: "New" },
        },
      });
    }).pipe(Effect.provide(layerReplayWithDriver(driver)), Effect.scoped);
    assert.equal((yield* Ref.get(driver.state)).failure, null);
  }),
);

it.effect("still rejects a changed non-discipline context value", () =>
  Effect.gen(function* () {
    const driver = yield* makeReplayDriver({
      provider: "codex",
      protocol: "codex.app-server",
      version: "test",
      scenario: "context-negative",
      entries: [
        {
          type: "expect_outbound",
          frame: {
            id: 1,
            method: "turn/start",
            params: {
              additionalContext: { goat_code_runtime: { kind: "application", value: "Expected" } },
            },
          },
        },
      ],
    });
    yield* Effect.gen(function* () {
      const client = yield* CodexAppServerClient;
      yield* client.raw
        .request("turn/start", {
          additionalContext: { t3_code_runtime: { kind: "application", value: "Changed" } },
        })
        .pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
    }).pipe(Effect.provide(layerReplayWithDriver(driver)), Effect.scoped);
    assert.equal(
      (yield* Ref.get(driver.state)).failure?._tag,
      "CodexAppServerReplayFrameMismatchError",
    );
  }),
);

it.effect.each([false, true])(
  "rejects conflicting context aliases in either insertion order (%s)",
  (reverse) =>
    Effect.gen(function* () {
      const entries = [
        ["t3_code_runtime", { kind: "application", value: "Legacy context must not disappear" }],
        ["goat_code_runtime", { kind: "application", value: "GOAT context" }],
      ] as const;
      const driver = yield* makeReplayDriver({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "context-collision",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              id: 1,
              method: "turn/start",
              params: {
                additionalContext: Object.fromEntries(reverse ? entries.toReversed() : entries),
              },
            },
          },
          { type: "emit_inbound", frame: { id: 1, result: {} } },
        ],
      });
      yield* Effect.gen(function* () {
        const client = yield* CodexAppServerClient;
        yield* client.raw
          .request("turn/start", {
            additionalContext: {
              goat_code_runtime: {
                kind: "application",
                value: reverse ? "Legacy context must not disappear" : "GOAT context",
              },
            },
          })
          .pipe(Effect.match({ onFailure: () => true, onSuccess: () => false }));
      }).pipe(Effect.provide(layerReplayWithDriver(driver)), Effect.scoped);
      assert.equal(
        (yield* Ref.get(driver.state)).failure?._tag,
        "CodexAppServerReplayFrameMismatchError",
      );
    }),
);
