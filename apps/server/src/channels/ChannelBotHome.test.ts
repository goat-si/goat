import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ServerSettingsError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";

const self = EnvironmentId.make("environment:self");
const other = EnvironmentId.make("environment:other");
const claim = (environmentId: EnvironmentId) => ({ environmentId, claimedAt: 1, claimId: "claim" });
const identity = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(self),
});

describe("ChannelBotHome", () => {
  it("recognizes unset, self and another home", () => {
    assert.isTrue(ChannelBotHome.isGoatBotHome(null, self));
    assert.isTrue(ChannelBotHome.isGoatBotHome(claim(self), self));
    assert.isFalse(ChannelBotHome.isGoatBotHome(claim(other), self));
  });
  it.effect("reads settings on every call and maps read failures to persistence_failed", () => {
    let reads = 0;
    const settings = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.suspend(() => {
        reads++;
        return reads === 1
          ? Effect.succeed(DEFAULT_SERVER_SETTINGS)
          : Effect.fail(
              new ServerSettingsError({
                settingsPath: "/test/settings.json",
                operation: "read-file",
                cause: new Error("unreadable"),
              }),
            );
      }),
    });
    return Effect.gen(function* () {
      const home = yield* ChannelBotHome.ChannelBotHome;
      yield* home.requireHome;
      assert.strictEqual((yield* Effect.flip(home.requireHome)).reason, "persistence_failed");
      assert.strictEqual(reads, 2);
    }).pipe(
      Effect.provide(ChannelBotHome.layer.pipe(Layer.provide(Layer.mergeAll(settings, identity)))),
    );
  });
});

describe("ChannelBotHome.claimHere", () => {
  const layer = ChannelBotHome.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ServerSettings.layerTest(), identity)),
  );
  it.effect.each([
    { name: "an older claim", claimedAt: 5, expected: 1_000 },
    // A claim stamped by a fast clock still loses: the new claim advances past it.
    { name: "a claim from the future", claimedAt: 9_000, expected: 9_001 },
  ])("takes the home over $name for another machine", ({ claimedAt, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        goatBotHome: { environmentId: other, claimedAt, claimId: "x" },
      });
      const home = yield* ChannelBotHome.ChannelBotHome;
      assert.isFalse((yield* home.read).isHome);
      const result = yield* home.claimHere(Effect.void);
      assert.isTrue(result.claimed);
      assert.deepInclude(result.home, { environmentId: self, claimedAt: expected });
      assert.deepStrictEqual(yield* home.read, {
        home: result.home,
        environmentId: self,
        isHome: true,
      });
      yield* home.requireHome;
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("checks the caller again inside the settings lock, after a write that held it", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const home = yield* ChannelBotHome.ChannelBotHome;
    yield* settings.updateSettings({
      goatBotHome: { environmentId: other, claimedAt: 5, claimId: "x" },
    });
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let holderDone = false;
    const holder = yield* settings
      .updateSettings(
        {},
        Deferred.succeed(locked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => void (holderDone = true))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(locked);
    const seenAtCommit: Array<boolean> = [];
    const claim = yield* home
      .claimHere(
        Effect.sync(() => void seenAtCommit.push(holderDone)).pipe(
          Effect.andThen(
            Effect.fail(
              new ServerSettingsError({ settingsPath: "revoked", operation: "normalize" }),
            ),
          ),
        ),
      )
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    assert.strictEqual((yield* Fiber.join(claim)).settingsPath, "revoked");
    // The authorization ran once, inside the lock and after the holder's write.
    assert.deepStrictEqual(seenAtCommit, [true]);
    assert.strictEqual((yield* settings.getSettings).goatBotHome?.environmentId, other);
  }).pipe(
    Effect.provide(
      ChannelBotHome.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(ServerSettings.layerTest(), identity)),
      ),
    ),
  ),
);

it.effect("reports the newer claim another write committed while this claim waited", () => {
  let armed: Deferred.Deferred<void> | undefined;
  // Signals when the claim has read the home it means to supersede.
  const observedSettings = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      return ServerSettings.ServerSettingsService.of({
        ...base,
        getSettings: base.getSettings.pipe(
          Effect.tap(() =>
            armed === undefined ? Effect.void : Deferred.succeed(armed, undefined),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest()));
  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000);
    const settings = yield* ServerSettings.ServerSettingsService;
    const home = yield* ChannelBotHome.ChannelBotHome;
    yield* settings.updateSettings({
      goatBotHome: { environmentId: other, claimedAt: 5, claimId: "old" },
    });
    const newer = { environmentId: other, claimedAt: 50_000, claimId: "newer" };
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* settings
      .updateSettings(
        { goatBotHome: newer },
        Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(locked);
    armed = yield* Deferred.make<void>();
    const claim = yield* home.claimHere(Effect.void).pipe(Effect.forkChild);
    yield* Deferred.await(armed);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    const result = yield* Fiber.join(claim);
    assert.deepStrictEqual(result, { claimed: false, home: newer, environmentId: self });
    assert.isFalse((yield* home.read).isHome);
  }).pipe(
    Effect.provide(
      ChannelBotHome.layer.pipe(Layer.provideMerge(Layer.mergeAll(observedSettings, identity))),
    ),
  );
});
