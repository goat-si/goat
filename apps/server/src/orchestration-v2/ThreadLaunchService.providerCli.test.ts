import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Gate from "../provider/ProviderCliGate.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput, modelSelection } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const missing = new Gate.ProviderCliMissingError({
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  host: "vm-1",
  binary: "codex",
  syncable: true,
  created: false,
});

const gate = (refuse: boolean, checked: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(
    Gate.ProviderCliGate,
    Gate.ProviderCliGate.of({
      require: (instanceId) =>
        Ref.update(checked, (all) => [...all, instanceId]).pipe(
          Effect.andThen(refuse ? Effect.fail(missing) : Effect.void),
        ),
      probe: () => Effect.die("launches only require"),
      missing: () => Effect.die("launches only require"),
    }),
  );

it.effect("a launch whose provider CLI is missing is refused before any thread exists", () =>
  Effect.gen(function* () {
    const checked = yield* Ref.make<ReadonlyArray<string>>([]);
    const harness = makeHarness({ providerCliGate: gate(true, checked) });
    const input = launchInput({
      command: "command:cli-missing",
      thread: "thread:cli-missing",
      message: "Hi",
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const refused = yield* launches.launch(input).pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderCliMissingError");
      assert.include(refused.message, "No thread was created.");
      assert.isNull(yield* threads.getThreadShell(input.threadId));
    }).pipe(Effect.provide(harness.layer));
    assert.deepEqual(yield* Ref.get(checked), [modelSelection.instanceId]);
  }),
);

it.effect("a launch whose provider CLI is present starts as before", () =>
  Effect.gen(function* () {
    const checked = yield* Ref.make<ReadonlyArray<string>>([]);
    const harness = makeHarness({ providerCliGate: gate(false, checked) });
    const input = launchInput({ command: "command:cli-present", thread: "thread:cli-present" });
    const launched = yield* Effect.flatMap(ThreadLaunch.ThreadLaunchService, (launches) =>
      launches.launch(input),
    ).pipe(Effect.provide(harness.layer));
    assert.equal(launched.threadId, input.threadId);
    assert.deepEqual(yield* Ref.get(checked), [modelSelection.instanceId]);
  }),
);

it.effect(
  "regression F1-1: a replay of a created launch returns its thread after the CLI vanished",
  () =>
    Effect.gen(function* () {
      const refuse = yield* Ref.make(false);
      const checked = yield* Ref.make<ReadonlyArray<string>>([]);
      const switchable = Layer.succeed(
        Gate.ProviderCliGate,
        Gate.ProviderCliGate.of({
          require: (instanceId) =>
            Ref.update(checked, (all) => [...all, instanceId]).pipe(
              Effect.andThen(Ref.get(refuse)),
              Effect.flatMap((gone) => (gone ? Effect.fail(missing) : Effect.void)),
            ),
          probe: () => Effect.die("launches only require"),
          missing: () => Effect.die("launches only require"),
        }),
      );
      const harness = makeHarness({ providerCliGate: switchable });
      const { threadId: _serverAllocates, ...input } = launchInput({
        command: "command:cli-replay",
        thread: "unused",
        message: "Only once",
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const first = yield* launches.launch(input);
        // The response was lost and the CLI disappeared before the client retried.
        yield* Ref.set(refuse, true);
        const retry = yield* launches.launch(input);
        assert.equal(retry.threadId, first.threadId);
        assert.isTrue(retry.resumed);
      }).pipe(Effect.provide(harness.layer));
      assert.deepEqual(yield* Ref.get(checked), [modelSelection.instanceId]);
    }),
);

it.effect(
  "regression F2L-1: a launch racing its own retry never reports the created thread as missing",
  () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const raced = Layer.succeed(
        Gate.ProviderCliGate,
        Gate.ProviderCliGate.of({
          require: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.succeed(checking, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.fail(missing),
              ),
            ),
          probe: () => Effect.die("launches only require"),
          missing: () => Effect.die("launches only require"),
        }),
      );
      const harness = makeHarness({ providerCliGate: raced });
      const { threadId: _serverAllocates, ...input } = launchInput({
        command: "command:cli-race",
        thread: "unused",
        message: "Only once",
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const first = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(checking);
        // The same command again while the first still checks, as a proxy retry would send it.
        const second = yield* launches
          .launch(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const created = yield* Fiber.join(first);
        const replayed = yield* Fiber.join(second);
        assert.equal(replayed.threadId, created.threadId);
        assert.isTrue(replayed.resumed);
      }).pipe(Effect.provide(harness.layer));
    }),
);
