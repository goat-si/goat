import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { listCodexModelSlugs, makeCodexModelArrivals } from "./CodexModelArrivals.ts";

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

it.effect("custom models are GOAT's own and are not checked", () =>
  Effect.gen(function* () {
    const { modelStatus, lists } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added, true)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added), "ready");
    assert.strictEqual(yield* lists, 0);
  }),
);

it.effect("a model GOAT does not offer is checked too; without a catalog it is unconfirmed", () =>
  Effect.gen(function* () {
    const withCatalog = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known)],
      served: [[known]],
    });
    assert.strictEqual(yield* withCatalog.modelStatus("other/unlisted"), "missing");
    // A pending or failed probe publishes no catalog, as for a scheduled run on a kept process.
    const noCatalog = yield* arrivals({ atOpen: [], now: [], served: [[known]] });
    assert.strictEqual(yield* noCatalog.modelStatus(added), "unconfirmed");
    assert.strictEqual(yield* noCatalog.modelStatus(known), "ready");
  }),
);

it.effect("only an exact slug counts as known", () =>
  Effect.gen(function* () {
    // A provider's own catalog resolves only exact slugs, so a listed prefix proves nothing.
    const { modelStatus } = yield* arrivals({
      atOpen: [model("gpt-5.5")],
      now: [model("gpt-5.5")],
      served: [["gpt-5.5"]],
    });
    assert.strictEqual(yield* modelStatus("gpt-5.5-preview"), "missing");
    assert.strictEqual(yield* modelStatus("custom/gpt-5.5"), "missing");
    assert.strictEqual(yield* modelStatus("gpt-5.5"), "ready");
  }),
);

it.effect(
  "a refusal always comes from a fresh listing, so a model learned since is not refused",
  () =>
    Effect.gen(function* () {
      const { modelStatus, lists } = yield* arrivals({
        atOpen: [model(known)],
        now: [model(known), model(added)],
        served: [[known], [known, added]],
      });
      assert.strictEqual(yield* modelStatus(added), "predated");
      // Codex refreshed its catalog online and lists the model now, within the quiet minute.
      assert.strictEqual(yield* modelStatus(added), "ready");
      assert.strictEqual(yield* modelStatus(known), "ready");
      assert.strictEqual(yield* lists, 2);
    }),
);

/** Two checks overlap: the second starts while the first waits for the process's answer. */
const overlappingChecks = (catalog: ReadonlyArray<ServerProviderModel>) =>
  Effect.gen(function* () {
    const lists = yield* Ref.make(0);
    const listing = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const modelStatus = makeCodexModelArrivals({
      atStart: catalog.filter((entry) => entry.slug !== added),
      offered: Effect.succeed(catalog),
      listServed: Ref.update(lists, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(listing, undefined)),
        Effect.andThen(Deferred.await(answer)),
        Effect.as([known]),
      ),
    });
    const first = yield* modelStatus(added).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(listing);
    // The second check runs until it waits, as an open started meanwhile on another thread would.
    const second = yield* modelStatus(added).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(answer, undefined);
    const answers = [yield* Fiber.join(first), yield* Fiber.join(second)];
    return { answers, lists: yield* Ref.get(lists) };
  });

it.effect("checks that overlap share one listing of the process, refusing or not", () =>
  Effect.gen(function* () {
    // Without GOAT's catalog an unlisted model is unconfirmed; with it, the model is predated.
    assert.deepStrictEqual(yield* overlappingChecks([]), {
      answers: ["unconfirmed", "unconfirmed"],
      lists: 1,
    });
    assert.deepStrictEqual(yield* overlappingChecks([model(known), model(added)]), {
      answers: ["predated", "predated"],
      lists: 1,
    });
  }),
);

it.effect("a process that just answered is not asked again for a model it did not list", () =>
  Effect.gen(function* () {
    // Without GOAT's catalog a miss is unconfirmed; the open's later checks reuse the answer.
    const { modelStatus, lists } = yield* arrivals({ atOpen: [], now: [], served: [[known]] });
    assert.strictEqual(yield* modelStatus(added), "unconfirmed");
    assert.strictEqual(yield* modelStatus(added), "unconfirmed");
    assert.strictEqual(yield* lists, 1);
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

it.effect(
  "a process that does not answer its model list is unconfirmed and asked again later",
  () =>
    Effect.gen(function* () {
      const lists = yield* Ref.make(0);
      const modelStatus = makeCodexModelArrivals({
        atStart: [model(known)],
        offered: Effect.succeed([model(known), model(added)]),
        listServed: Ref.update(lists, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      });
      const answer = yield* modelStatus(added).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Fiber.join(answer), "unconfirmed");
      // The open that asked checks again before its turn; that check must not wait once more.
      assert.strictEqual(yield* modelStatus(added), "unconfirmed");
      assert.strictEqual(yield* Ref.get(lists), 1);
      yield* TestClock.adjust("1 minute");
      const later = yield* modelStatus(added).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(yield* Fiber.join(later), "unconfirmed");
      assert.strictEqual(yield* Ref.get(lists), 2);
    }),
);

it.effect("a hidden model the serving process still runs is ready", () =>
  Effect.gen(function* () {
    const hidden = "gpt-hidden-but-usable";
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      // model/list leaves hidden models out unless asked, as the picker's list does.
      listServed: listCodexModelSlugs((params) =>
        Effect.succeed({
          data: params.includeHidden ? [{ model: known }, { model: hidden }] : [{ model: known }],
          nextCursor: null,
        }),
      ),
    });
    assert.strictEqual(yield* modelStatus(hidden), "ready");
  }),
);

it.effect("a cached-only answer never asks the process", () =>
  Effect.gen(function* () {
    const { modelStatus, lists } = yield* arrivals({
      atOpen: [model(known)],
      now: [model(known), model(added)],
      served: [[known]],
    });
    assert.strictEqual(yield* modelStatus(added, { cachedOnly: true }), "unconfirmed");
    assert.strictEqual(yield* lists, 0);
    assert.strictEqual(yield* modelStatus(added), "predated");
    assert.strictEqual(yield* modelStatus(added, { cachedOnly: true }), "predated");
    assert.strictEqual(yield* lists, 1);
  }),
);

it.effect("an answer taken before GOAT's catalog changed is listed again before it refuses", () =>
  Effect.gen(function* () {
    const offered: Array<ServerProviderModel> = [];
    const lists = yield* Ref.make(0);
    const served = [[known], [known, added]];
    const modelStatus = makeCodexModelArrivals({
      atStart: [],
      offered: Effect.sync(() => [...offered]),
      listServed: Ref.getAndUpdate(lists, (count) => count + 1).pipe(
        Effect.map((count) => served[Math.min(count, served.length - 1)] ?? []),
      ),
    });
    // The open began before both checks; without a catalog its first answer is unconfirmed.
    const since = -1;
    assert.strictEqual(yield* modelStatus(added, { since }), "unconfirmed");
    // GOAT's catalog arrives and the process learns the model before the open's second check.
    offered.push(model(known), model(added));
    assert.strictEqual(yield* modelStatus(added, { since }), "ready");
    assert.strictEqual(yield* Ref.get(lists), 2);
  }),
);
