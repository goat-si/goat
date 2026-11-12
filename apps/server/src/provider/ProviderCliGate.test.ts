import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as Gate from "./ProviderCliGate.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const codex = ProviderInstanceId.make("codex");
const EPOCH = "1970-01-01T00:00:00.000Z";
const requireCli = (instanceId: ProviderInstanceId) =>
  Effect.flatMap(Gate.ProviderCliGate, (gate) => gate.require(instanceId));

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "0.133.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: EPOCH,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

/**
 * cached is what the registry last published; probe is what the next refresh of the instance
 * produces. hold, when given, keeps every refresh open until it is completed.
 */
const fixture = (input: {
  readonly cached: ServerProvider;
  readonly probe: Effect.Effect<ServerProvider>;
  readonly hold?: Deferred.Deferred<void>;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  Effect.gen(function* () {
    const probes = yield* Ref.make(0);
    const entered = yield* Deferred.make<void>();
    const cached = yield* Ref.make([input.cached]);
    const instance = {
      instanceId: input.cached.instanceId,
      driverKind: input.cached.driver,
      snapshot: {
        refresh: Ref.update(probes, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(input.hold === undefined ? Effect.void : Deferred.await(input.hold)),
          Effect.andThen(input.probe),
          Effect.tap((next) => Ref.set(cached, [next])),
        ),
      },
    } as unknown as ProviderInstance;
    const current = yield* Ref.make<ProviderInstance | undefined>(instance);
    const layer = Gate.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Ref.get(cached) }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Ref.get(current),
            listInstances: Ref.get(current).pipe(Effect.map((entry) => (entry ? [entry] : []))),
          }),
          ServerSettings.layerTest(input.settings ?? {}),
          Layer.succeed(HostProcess.Hostname, "vm-1"),
        ),
      ),
    );
    return { probes, entered, current, layer };
  });

it.effect("a CLI probed present within ten minutes launches without probing again", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      cached: provider({ cli: "present", cliCheckedAt: EPOCH }),
      probe: Effect.die("no probe expected"),
    });
    yield* TestClock.adjust("9 minutes");
    yield* requireCli(codex).pipe(Effect.provide(f.layer));
    expect(yield* Ref.get(f.probes)).toBe(0);
  }),
);

it.effect("an older present is probed again, so a CLI that disappeared is refused", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      cached: provider({ cli: "present", cliCheckedAt: EPOCH }),
      probe: Effect.succeed(provider({ installed: false, status: "error", cli: "missing" })),
    });
    yield* TestClock.adjust("11 minutes");
    const refused = yield* requireCli(codex).pipe(Effect.flip, Effect.provide(f.layer));
    expect(yield* Ref.get(f.probes)).toBe(1);
    expect(refused._tag).toBe("ProviderCliMissingError");
    expect(refused.message).toBe(
      'Codex is not installed on vm-1 (the codex command was not found). Install it with goat_call {path:"provider.sync", args:{driver:"codex", login:false}} on that machine, or in Settings → Connections → Providers on your machines. No thread was created.',
    );
    expect(refused.code).toBe("provider_cli_missing");
  }),
);

it.effect("a cached missing whose probe fails launches: only a fresh answer refuses", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      cached: provider({ installed: false, status: "error", cli: "missing" }),
      probe: Effect.die("probe crashed"),
    });
    yield* requireCli(codex).pipe(Effect.provide(f.layer));
    expect(yield* Ref.get(f.probes)).toBe(1);
  }),
);

it.effect("a CLI installed since the last check launches after one probe", () =>
  Effect.gen(function* () {
    const f = yield* fixture({
      cached: provider({ installed: false, status: "error", cli: "missing" }),
      probe: Effect.succeed(provider({ cli: "present" })),
    });
    yield* requireCli(codex).pipe(Effect.provide(f.layer));
    expect(yield* Ref.get(f.probes)).toBe(1);
  }),
);

it.effect("an instance with its own Binary path is told to fix it, not to run provider.sync", () =>
  Effect.gen(function* () {
    const missing = provider({ installed: false, status: "error", cli: "missing" });
    const f = yield* fixture({
      cached: missing,
      probe: Effect.succeed(missing),
      settings: {
        providerInstances: {
          [codex]: {
            driver: ProviderDriverKind.make("codex"),
            config: { binaryPath: "/opt/codex-beta" },
          },
        },
      },
    });
    const refused = yield* requireCli(codex).pipe(Effect.flip, Effect.provide(f.layer));
    expect(refused.syncable).toBe(false);
    expect(refused.message).toBe(
      "Codex on vm-1 runs /opt/codex-beta, which was not found. Fix its Binary path or environment in Settings → Providers on that machine. No thread was created.",
    );
  }),
);

it.effect("drivers without a CLI on PATH and instances that run none are never probed", () =>
  Effect.gen(function* () {
    for (const cached of [
      provider({ driver: ProviderDriverKind.make("cursor") }),
      provider({ cli: "none", cliCheckedAt: EPOCH }),
    ]) {
      const f = yield* fixture({ cached, probe: Effect.die("no probe expected") });
      yield* requireCli(codex).pipe(Effect.provide(f.layer));
      expect(yield* Ref.get(f.probes)).toBe(0);
    }
  }),
);

it.effect("concurrent launches share one probe", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const f = yield* fixture({
      cached: provider(),
      probe: Effect.succeed(provider({ cli: "present" })),
      hold,
    });
    yield* Effect.gen(function* () {
      const first = yield* requireCli(codex).pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      // Started at once, so it joins the held probe before the probe is released.
      const second = yield* requireCli(codex).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(f.layer));
    expect(yield* Ref.get(f.probes)).toBe(1);
  }),
);

it.effect("a fresh probe waits out a probe that started before it and runs its own", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const answers = yield* Ref.make([
      provider({ installed: false, status: "error", cli: "missing" }),
      provider({ cli: "present" }),
    ]);
    const f = yield* fixture({
      cached: provider(),
      probe: Ref.modify(answers, ([next, ...rest]) => [next!, rest]),
      hold,
    });
    const answer = yield* Effect.gen(function* () {
      const gate = yield* Gate.ProviderCliGate;
      const before = yield* gate.probe(codex).pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      const after = yield* gate
        .probe(codex, { fresh: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(hold, undefined);
      expect((yield* Fiber.join(before)).kind).toBe("missing");
      return yield* Fiber.join(after);
    }).pipe(Effect.provide(f.layer));
    expect(answer.kind).toBe("present");
    expect(yield* Ref.get(f.probes)).toBe(2);
  }),
);

it.effect("a probe of an instance that settings replaced meanwhile answers nothing", () =>
  Effect.gen(function* () {
    const hold = yield* Deferred.make<void>();
    const f = yield* fixture({
      cached: provider(),
      probe: Effect.succeed(provider({ installed: false, status: "error", cli: "missing" })),
      hold,
    });
    yield* Effect.gen(function* () {
      const launch = yield* requireCli(codex).pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      yield* Ref.set(f.current, { ...(yield* Ref.get(f.current))! });
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(launch);
    }).pipe(Effect.provide(f.layer));
  }),
);
