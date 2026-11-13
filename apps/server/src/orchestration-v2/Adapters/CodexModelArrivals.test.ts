import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture paths.
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
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

/** A Codex catalog file as `model_catalog_json` points at it, last written at `writtenAtMs`. */
const writeCatalog = (
  filename: string,
  windows: Readonly<Record<string, number>>,
  writtenAtMs: number,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const models = Object.entries(windows).map(([slug, contextWindow]) => ({
      slug,
      context_window: contextWindow,
    }));
    yield* fs.writeFileString(filename, JSON.stringify({ models }));
    yield* fs.utimes(filename, writtenAtMs / 1000, writtenAtMs / 1000);
  });

/** A process started at `startedAtMs` that lists both models and reads its catalog from `filename`. */
const catalogArrivals = (filename: string, startedAtMs: number) =>
  Effect.gen(function* () {
    const configReads = yield* Ref.make(0);
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known), model(added)],
      offered: Effect.succeed([model(known), model(added)]),
      listServed: Effect.succeed([known, added]),
      startedAtMs,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: yield* FileSystem.FileSystem,
        readConfig: Ref.update(configReads, (count) => count + 1).pipe(
          Effect.as({ config: { model_catalog_json: filename } }),
        ),
      },
    });
    return { modelStatus, configReads: Ref.get(configReads) };
  });

it.effect(
  "a model whose catalog entry changed after the process started is outdated; others stay ready",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
      yield* writeCatalog(filename, { [known]: 272_000, [added]: 400_000 }, 1_000);
      const { modelStatus, configReads } = yield* catalogArrivals(filename, 2_000);
      assert.strictEqual(yield* modelStatus(known), "ready");

      // The catalog sync raised one model's window while the process kept its startup copy.
      yield* writeCatalog(filename, { [known]: 1_048_576, [added]: 400_000 }, 3_000);
      assert.strictEqual(yield* modelStatus(known), "outdated");
      assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
      assert.strictEqual(yield* modelStatus(added), "ready");
      assert.strictEqual(yield* modelStatus("not/in-the-catalog"), "missing");
      assert.strictEqual(yield* configReads, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a catalog changed before GOAT first read it leaves every catalogued model outdated",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
      // As for a kept process: the file changed after it started and before GOAT looked.
      yield* writeCatalog(filename, { [known]: 1_048_576, [added]: 400_000 }, 3_000);
      const { modelStatus } = yield* catalogArrivals(filename, 2_000);
      assert.strictEqual(yield* modelStatus(known), "outdated");
      assert.strictEqual(yield* modelStatus(added), "outdated");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a catalog rewritten while GOAT reads it never becomes what the process started with",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
      yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
      let rewrites = 0;
      const rewrite = writeCatalog(filename, { [known]: 1_048_576 }, 3_000).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      // The sync replaces the file after GOAT's stat and before its read.
      const racingFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: (path, encoding) =>
          (rewrites++ === 0 ? rewrite : Effect.void).pipe(
            Effect.andThen(fs.readFileString(path, encoding)),
          ),
      };
      const modelStatus = makeCodexModelArrivals({
        atStart: [model(known)],
        offered: Effect.succeed([model(known)]),
        listServed: Effect.succeed([known]),
        startedAtMs: 2_000,
        catalog: {
          cwd: "/",
          home: undefined,
          fileSystem: racingFs,
          readConfig: Effect.succeed({ config: { model_catalog_json: filename } }),
        },
      });
      yield* modelStatus(known);
      assert.strictEqual(yield* modelStatus(known), "outdated");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a process that could not say where its catalog is is asked again a minute later", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 1_048_576 }, 3_000);
    const answers = [false, true];
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: fs,
        readConfig: Effect.suspend(() =>
          answers.shift() === true
            ? Effect.succeed({ config: { model_catalog_json: filename } })
            : Effect.fail("busy"),
        ),
      },
    });
    assert.strictEqual(yield* modelStatus(known), "ready");
    assert.strictEqual(yield* modelStatus(known), "ready");
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(yield* modelStatus(known), "outdated");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a catalog file that does not answer placement in a moment counts as changed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
    let stuck = false;
    // A slow or hung file system, as a network mount can be.
    const stuckFs: FileSystem.FileSystem = {
      ...fs,
      stat: (path) => (stuck ? Effect.never : fs.stat(path)),
    };
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: stuckFs,
        readConfig: Effect.succeed({ config: { model_catalog_json: filename } }),
      },
    });
    assert.strictEqual(yield* modelStatus(known), "ready");
    stuck = true;
    // Placement holds dispatch, so it waits only briefly, and an unconfirmed file may have changed.
    const placed = yield* modelStatus(known, { cachedOnly: true }).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("50 millis");
    assert.strictEqual(yield* Fiber.join(placed), "outdated");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("placement sees a catalog change before GOAT has read the new file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
    let reading = true;
    // The background read cannot land before placement answers.
    const slowFs: FileSystem.FileSystem = {
      ...fs,
      readFileString: (path, encoding) =>
        reading ? fs.readFileString(path, encoding) : Effect.never,
    };
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: slowFs,
        readConfig: Effect.succeed({ config: { model_catalog_json: filename } }),
      },
    });
    assert.strictEqual(yield* modelStatus(known), "ready");
    yield* writeCatalog(filename, { [known]: 1_048_576 }, 3_000);
    reading = false;
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("placement treats a catalog GOAT could never read as changed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
    let reads = 0;
    // The first read never finishes, as on a briefly hung file system.
    const flakyFs: FileSystem.FileSystem = {
      ...fs,
      readFileString: (path, encoding) =>
        reads++ === 0 ? Effect.never : fs.readFileString(path, encoding),
    };
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: flakyFs,
        readConfig: Effect.succeed({ config: { model_catalog_json: filename } }),
      },
    });
    const first = yield* modelStatus(known).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 seconds");
    assert.strictEqual(yield* Fiber.join(first), "ready");
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "placement isolates a new thread while the process has not said where its catalog is",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
      yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
      const modelStatus = makeCodexModelArrivals({
        atStart: [model(known)],
        offered: Effect.succeed([model(known)]),
        listServed: Effect.succeed([known]),
        startedAtMs: 2_000,
        catalog: {
          cwd: "/",
          home: undefined,
          fileSystem: fs,
          // The busy process does not answer config/read during this retry window.
          readConfig: Effect.fail("busy"),
        },
      });
      assert.strictEqual(yield* modelStatus(known), "ready");
      yield* writeCatalog(filename, { [known]: 1_048_576 }, 3_000);
      assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("placement isolates a new thread while the first catalog lookup is still pending", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
    const answer = yield* Deferred.make<void>();
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: fs,
        readConfig: Deferred.await(answer).pipe(
          Effect.as({ config: { model_catalog_json: filename } }),
        ),
      },
    });
    // The turn's own check is still waiting for config/read when the next thread is placed.
    const opening = yield* modelStatus(known).pipe(Effect.forkChild({ startImmediately: true }));
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
    yield* Deferred.succeed(answer, undefined);
    assert.strictEqual(yield* Fiber.join(opening), "ready");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a process with no catalog configured never isolates new threads once it says so", () =>
  Effect.gen(function* () {
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: yield* FileSystem.FileSystem,
        readConfig: Effect.succeed({ config: {} }),
      },
    });
    assert.strictEqual(yield* modelStatus(known), "ready");
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "ready");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a catalog that changed into something GOAT cannot parse still counts as changed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filename = NodePath.join(yield* fs.makeTempDirectoryScoped(), "catalog.json");
    yield* writeCatalog(filename, { [known]: 272_000 }, 1_000);
    const { modelStatus } = yield* catalogArrivals(filename, 2_000);
    assert.strictEqual(yield* modelStatus(known), "ready");
    // The sync is midway through writing it, or wrote something that is not a catalog.
    yield* fs.writeFileString(filename, "{ not json");
    yield* fs.utimes(filename, 3, 3);
    yield* modelStatus(known);
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a home-relative catalog path GOAT cannot resolve is not taken for no catalog", () =>
  Effect.gen(function* () {
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known)],
      offered: Effect.succeed([model(known)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: yield* FileSystem.FileSystem,
        readConfig: Effect.succeed({ config: { model_catalog_json: "~/catalog.json" } }),
      },
    });
    assert.strictEqual(yield* modelStatus(known), "ready");
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("custom models stay GOAT's own and skip the catalog check", () =>
  Effect.gen(function* () {
    const custom = "custom/my-model";
    const modelStatus = makeCodexModelArrivals({
      atStart: [model(known), model(custom, true)],
      offered: Effect.succeed([model(known), model(custom, true)]),
      listServed: Effect.succeed([known]),
      startedAtMs: 2_000,
      catalog: {
        cwd: "/",
        home: undefined,
        fileSystem: yield* FileSystem.FileSystem,
        // Codex has not answered yet, so every catalog model counts as unconfirmed.
        readConfig: Effect.never,
      },
    });
    assert.strictEqual(yield* modelStatus(custom, { cachedOnly: true }), "ready");
    assert.strictEqual(yield* modelStatus(known, { cachedOnly: true }), "outdated");
  }).pipe(Effect.provide(NodeServices.layer)),
);
