import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeCachedProviderMaintenanceResolution } from "./maintenanceCache.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./maintenanceResolver.ts";

/** A keyed resolution whose capabilities name the registry the lookup read. */
const registryResolution = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    let lookups = 0;
    const resolve = yield* makeCachedProviderMaintenanceResolution(Effect.die("unkeyed"), {
      lookup: Effect.sync(() => ({ env: { ...env }, resolvedCommandPath: `${env.PATH}/tool` })),
      resolve: (lookup) =>
        Effect.sync(() => {
          lookups += 1;
          return makeManualOnlyProviderMaintenanceCapabilities({
            provider: ProviderDriverKind.make("codex"),
            packageName: lookup.env.NPM_CONFIG_REGISTRY ?? null,
          });
        }),
    });
    const registry = (options?: { readonly fresh?: boolean }) =>
      Effect.map(resolve(options), (capabilities) => capabilities.packageName);
    return { registry, lookups: () => lookups };
  });

it.effect("a registry change with PATH unchanged reaches the next check within the hour", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "/a", NPM_CONFIG_REGISTRY: "https://a.example" };
    const { registry } = yield* registryResolution(env);
    assert.strictEqual(yield* registry(), "https://a.example");
    // A PATH change late in the hour starts a fresh entry, still under registry A.
    yield* TestClock.adjust("50 minutes");
    env.PATH = "/b";
    assert.strictEqual(yield* registry(), "https://a.example");
    yield* TestClock.adjust("5 minutes");
    env.NPM_CONFIG_REGISTRY = "https://b.example";
    assert.strictEqual(yield* registry(), "https://b.example");
  }),
);

it.effect("an unchanged environment is served from the cache until a refresh asks again", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "/a", NPM_CONFIG_REGISTRY: "https://a.example" };
    const { registry, lookups } = yield* registryResolution(env);
    yield* registry();
    yield* TestClock.adjust("30 minutes");
    yield* registry();
    assert.strictEqual(lookups(), 1);
    yield* registry({ fresh: true });
    assert.strictEqual(lookups(), 2);
  }),
);
