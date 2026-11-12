import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";
import * as Effect from "effect/Effect";
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
