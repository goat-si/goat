import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { makeCodexModelArrivals } from "./CodexModelArrivals.ts";

const model = (slug: string, isCustom = false): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});
const known = "hyds/deepseek-v4.1-flash";
const added = "combo/deepseek-flash-pool";

/** A process started while GOAT offered `atOpen`; GOAT now offers `now`; the process lists `served`. */
const arrivals = (input: {
  readonly atOpen: ReadonlyArray<ServerProviderModel>;
  readonly now: ReadonlyArray<ServerProviderModel>;
  readonly served: ReadonlyArray<ReadonlyArray<string>>;
}) =>
  Effect.gen(function* () {
    const lists = yield* Ref.make(0);
    const modelStatus = makeCodexModelArrivals({
      atStart: input.atOpen,
      offered: Effect.succeed(input.now),
      listServed: Ref.getAndUpdate(lists, (count) => count + 1).pipe(
        Effect.map((count) => input.served[Math.min(count, input.served.length - 1)] ?? []),
      ),
    });
    return { modelStatus, lists: Ref.get(lists) };
  });

it.effect("a model GOAT began offering after the process started is predated", () =>
  Effect.gen(function* () {
    const { modelStatus } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added), "predated");
    assert.strictEqual(yield* modelStatus(known), "ready");
  }),
);

it.effect("a model GOAT offered at start but the process does not list is missing", () =>
  Effect.gen(function* () {
    // The probe that fills GOAT's list can load a different catalog than the serving process.
    const { modelStatus } = yield* arrivals({
      atOpen: [model(known), model(added)],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added), "missing");
  }),
);

it.effect("custom models and models GOAT does not offer are not checked", () =>
  Effect.gen(function* () {
    const { modelStatus, lists } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added, true)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added), "ready");
    assert.strictEqual(yield* modelStatus("not/offered"), "ready");
    assert.strictEqual(yield* lists, 0);
  }),
);

it.effect("a model the process learns later is listed again on a miss, then remembered", () =>
  Effect.gen(function* () {
    const { modelStatus, lists } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added)],
      served: [[known], [known, added]],
    });
    assert.strictEqual(yield* modelStatus(added), "predated");
    // Codex refreshed its catalog online and now lists the model.
    assert.strictEqual(yield* modelStatus(added), "ready");
    assert.strictEqual(yield* modelStatus(known), "ready");
    assert.strictEqual(yield* lists, 2);
  }),
);

it.effect("a process whose start GOAT did not see judges every offered model by its listing", () =>
  Effect.gen(function* () {
    const { modelStatus } = yield* arrivals({
      atOpen: [],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added), "predated");
    assert.strictEqual(yield* modelStatus(known), "ready");
  }),
);

it.effect("a process that cannot list its models is unconfirmed for every offered model", () =>
  Effect.gen(function* () {
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known), model(added)]),
      listServed: Effect.fail("model/list failed"),
    });
    assert.strictEqual(yield* modelStatus(added), "unconfirmed");
    assert.strictEqual(yield* modelStatus(known), "unconfirmed");
  }),
);

it.effect("a process that does not answer its model list is unconfirmed", () =>
  Effect.gen(function* () {
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known), model(added)]),
      listServed: Effect.never,
    });
    const answer = yield* modelStatus(added).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual(yield* Fiber.join(answer), "unconfirmed");
  }),
);
