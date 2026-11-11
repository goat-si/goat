import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

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
    const predatesModel = makeCodexModelArrivals({
      atStart: input.atOpen,
      offered: Effect.succeed(input.now),
      listServed: Ref.getAndUpdate(lists, (count) => count + 1).pipe(
        Effect.map((count) => input.served[Math.min(count, input.served.length - 1)] ?? []),
      ),
    });
    return { predatesModel, lists: Ref.get(lists) };
  });

it.effect("a Codex process predates a model GOAT began offering after it opened", () =>
  Effect.gen(function* () {
    const { predatesModel } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.isTrue(yield* predatesModel(added));
    assert.isFalse(yield* predatesModel(known));
  }),
);

it.effect("models no fresh Codex process would know never count as predated", () =>
  Effect.gen(function* () {
    // A custom model is GOAT's, not Codex's catalog's.
    const custom = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added, true)],
      served: [[known]],
    });
    assert.isFalse(yield* custom.predatesModel(added));
    // Offered when the process opened but missing from it: a fresh process would miss it too.
    const mismatch = yield* arrivals({
      atOpen: [model(known), model(added)],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.isFalse(yield* mismatch.predatesModel(added));
    assert.isFalse(yield* mismatch.predatesModel("not/offered"));
  }),
);

it.effect("a model the process learns later is listed again on a miss, then remembered", () =>
  Effect.gen(function* () {
    const { predatesModel, lists } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added)],
      served: [[known], [known, added]],
    });
    assert.isTrue(yield* predatesModel(added));
    // Codex refreshed its catalog online and now lists the model.
    assert.isFalse(yield* predatesModel(added));
    assert.isFalse(yield* predatesModel(added));
    assert.strictEqual(yield* lists, 2);
  }),
);

it.effect("a process opened before GOAT's first model list still predates later models", () =>
  Effect.gen(function* () {
    const { predatesModel } = yield* arrivals({
      atOpen: [],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.isTrue(yield* predatesModel(added));
  }),
);

it.effect("a process that cannot list its models is never refused or restarted for it", () =>
  Effect.gen(function* () {
    const predatesModel = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known), model(added)]),
      listServed: Effect.fail("model/list failed"),
    });
    assert.isFalse(yield* predatesModel(added));
  }),
);
