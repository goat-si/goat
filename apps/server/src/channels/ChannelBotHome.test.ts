import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
