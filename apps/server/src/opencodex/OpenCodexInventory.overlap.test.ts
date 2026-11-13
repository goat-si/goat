import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as HubLinkTraffic from "../hub/HubLinkTraffic.ts";
import * as Settings from "../serverSettings.ts";
import fleet from "./fixtures/fleet.json" with { type: "json" };
import { setup } from "./OpenCodexInventory.testkit.ts";

const linkStatus = (toHomeBytes: number) =>
  JSON.stringify({
    role: "home",
    links: [
      {
        id: "lnk_a",
        alias: "mac-ts",
        tunnelPort: 54001,
        direction: "hub-initiated",
        state: "connected",
        traffic: { epoch: "ab12cd34", generation: 3, toHomeBytes, fromHomeBytes: 0 },
      },
    ],
  });

it.effect(
  "of two overlapping link reads, the one that started first counts as the older, so the next read does not count the overlap again",
  () =>
    Effect.gen(function* () {
      const linkTraffic = yield* HubLinkTraffic.make(
        Effect.sync((): ReadonlySet<string> | undefined => undefined),
      ).pipe(Effect.provide(Settings.ServerSettingsService.layerTest()));
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Each link read answers in turn: the first waits until released, holding the oldest count.
      const answers = [
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(linkStatus(1_000_000)),
        ),
        Effect.succeed(linkStatus(2_000_000)),
        Effect.succeed(linkStatus(3_000_000)),
      ];
      const { inventory } = yield* setup({
        fixture: fleet.home,
        linkTraffic,
        command: (input) =>
          input.args[0] === "link"
            ? (answers.shift() ?? Effect.die("an unexpected link read"))
            : Effect.succeed(
                JSON.stringify(
                  input.args[0] === "connect"
                    ? fleet.home.connect
                    : input.args[0] === "service"
                      ? fleet.home.service
                      : fleet.home.status,
                ),
              ),
      });
      const older = yield* inventory.readParity.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 seconds");
      yield* inventory.readParity;
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(older);
      yield* TestClock.adjust("3 seconds");
      const latest = yield* inventory.readParity;
      expect(latest.link.links[0]?.traffic?.day.toHomeBytes).toBe(1_000_000);
    }),
);
