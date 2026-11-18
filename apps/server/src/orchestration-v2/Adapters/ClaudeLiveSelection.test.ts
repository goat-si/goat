import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";
import type { ClaudeFlagSettings } from "./ClaudeAgentSdkQueryRunner.ts";
import {
  applyClaudeSelectionLive,
  applyClaudeSelectionToRunningQuery,
  claudeSelectionAppliesToRunningQuery,
} from "./ClaudeLiveSelection.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerErrors.ts";

const compiled = (
  apiModelId: string,
  effort: string | undefined,
  settings: Record<string, boolean> = {},
): CompiledClaudeModelSelection => ({
  apiModelId,
  effort,
  promptEffort: undefined,
  settings,
  queryIdentity: JSON.stringify({ apiModelId, effort: effort ?? null, settings }),
});

const running = {
  stopping: false,
  nativeThreadId: "native",
  selection: compiled("sonnet", "high"),
};

it("lets only an effort or fast mode change on the same model and thread reach a running Claude process", () => {
  const applies = (next: CompiledClaudeModelSelection, live = running, nativeId = "native") =>
    claudeSelectionAppliesToRunningQuery(live, next, nativeId);
  assert.isTrue(applies(compiled("sonnet", "medium")));
  assert.isTrue(applies(compiled("sonnet", "high", { fastMode: true })));
  // A model change waits for the turn that checks it against the turn's permission mode.
  assert.isFalse(applies(compiled("opus", "medium")));
  // Thinking needs a new process; clearing effort needs one to reload user settings.
  assert.isFalse(applies(compiled("sonnet", "high", { alwaysThinkingEnabled: true })));
  assert.isFalse(applies(compiled("sonnet", undefined)));
  assert.isFalse(applies(compiled("sonnet", "high")));
  assert.isFalse(applies(compiled("sonnet", "medium"), { ...running, stopping: true }));
  assert.isFalse(applies(compiled("sonnet", "medium"), running, "another-native-thread"));
});

it.effect(
  "a CLI that rejects the live change keeps its turn and leaves the change to the next turn",
  () =>
    Effect.gen(function* () {
      const live = {
        ...running,
        reportedModel: "sonnet",
        query: {
          setModel: () => Effect.die("an effort change keeps the model"),
          applyFlagSettings: () =>
            Effect.fail(
              new ClaudeAgentSdkQueryRunnerError({
                method: "applyFlagSettings",
                cause: "unknown control request",
              }),
            ),
        },
      };
      yield* applyClaudeSelectionToRunningQuery(live, compiled("sonnet", "medium"), "native");
      assert.equal(live.selection.queryIdentity, "");
      assert.equal(live.selection.effort, "high");
    }),
);

it.effect("an interrupted live change leaves the identity unknown so the next turn sends it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const live = {
      ...running,
      reportedModel: "sonnet",
      query: {
        setModel: () => Effect.void,
        applyFlagSettings: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      },
    };
    const applying = yield* applyClaudeSelectionLive(live, compiled("sonnet", "medium")).pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(applying);
    assert.equal(live.selection.queryIdentity, "");
  }),
);

it.effect("a reactor change and a steer's change on one process run one after the other", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const firstStarted = yield* Deferred.make<void>();
    const live = {
      ...running,
      reportedModel: "sonnet",
      query: {
        setModel: (model: string) => Effect.sync(() => calls.push(`model:${model}`)),
        applyFlagSettings: (settings: ClaudeFlagSettings) =>
          Effect.sync(() => calls.push(`flags:${settings.effortLevel}:start`)).pipe(
            Effect.andThen(
              settings.effortLevel === "medium"
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  )
                : Effect.void,
            ),
            Effect.andThen(Effect.sync(() => calls.push(`flags:${settings.effortLevel}:end`))),
          ),
      },
    };
    const reactor = yield* applyClaudeSelectionToRunningQuery(
      live,
      compiled("sonnet", "medium"),
      "native",
    ).pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const steer = yield* applyClaudeSelectionLive(live, compiled("opus", "low")).pipe(
      Effect.forkChild,
    );
    // Unlocked, the steer's calls would all finish while the reactor's call is still blocked.
    const waited = yield* Fiber.await(steer).pipe(
      Effect.timeoutOption("1 second"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    assert.isTrue(Option.isNone(yield* Fiber.join(waited)));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(reactor);
    yield* Fiber.join(steer);
    assert.deepEqual(calls, [
      "flags:medium:start",
      "flags:medium:end",
      "model:opus",
      "flags:low:start",
      "flags:low:end",
    ]);
    assert.equal(live.selection.apiModelId, "opus");
  }),
);

it.effect("an interrupted change frees the process for the next one", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const calls: Array<string> = [];
    const live = {
      ...running,
      reportedModel: "sonnet",
      query: {
        setModel: (model: string) => Effect.sync(() => calls.push(model)),
        applyFlagSettings: (settings: ClaudeFlagSettings) =>
          settings.effortLevel === "medium"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.sync(() => calls.push(String(settings.effortLevel))),
      },
    };
    const reactor = yield* applyClaudeSelectionToRunningQuery(
      live,
      compiled("sonnet", "medium"),
      "native",
    ).pipe(Effect.timeout("10 seconds"), Effect.ignore, Effect.forkChild);
    yield* Deferred.await(started);
    const steer = yield* applyClaudeSelectionLive(live, compiled("sonnet", "low")).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(reactor);
    yield* Fiber.join(steer);
    assert.deepEqual(calls, ["sonnet", "low"]);
  }),
);
