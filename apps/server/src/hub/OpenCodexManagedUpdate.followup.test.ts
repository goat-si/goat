import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as TestClock from "effect/testing/TestClock";

import { makeFleet, MINUTE, setup } from "./OpenCodexManagedUpdate.testkit.ts";

const decodeFailed = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ failedTargets: Schema.Record(Schema.String, Schema.String) }),
  ),
);

it.layer(NodeServices.layer)("OpenCodex SSH replacement follow-up", (it) => {
  it.effect("keeps an in-flight plan pending until a later determinate check", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.orchestrated = true;
      fleet.inFlight = true;
      fleet.automatic = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.planReads).toBe(1);
      fleet.inFlight = false;
      fleet.planMode = "none";
      yield* TestClock.adjust(10 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
      yield* TestClock.adjust(6 * 60 * MINUTE);
      yield* update.check;
      expect(fleet.planReads).toBe(2);
    }),
  );

  it.effect("does not run a follow-up while automatic server updates are disabled", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.orchestrated = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.planReads).toBe(0);
      fleet.automatic = true;
      fleet.planMode = "none";
      yield* update.checkNow;
      expect(fleet.planReads).toBeGreaterThan(0);
    }),
  );

  it.effect("settles a follow-up coordinated by another Home", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.automatic = true;
      fleet.hub = false;
      fleet.childRole = true;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect((yield* update.status)?.reason).toBe("coordinated-by-home");
      fleet.childRole = false;
      expect((yield* update.checkNow)?.reason).toBe("coordinated-by-home");
      expect(fleet.installs).toEqual([]);
    }),
  );

  it.effect("settles a follow-up after a rolled-back window closes", () =>
    Effect.gen(function* () {
      const fleet = makeFleet({ homeOwnership: "adopted" });
      fleet.versions.set("mac-studio", "2.90.0");
      fleet.orchestrated = true;
      fleet.applyResult = "rolled-back";
      fleet.automatic = true;
      fleet.hub = false;
      fleet.runtimeReplaced = "1.1.0";
      const { update } = yield* setup(fleet);
      yield* update.check;
      expect(fleet.applyCalls).toBe(1);
      yield* update.checkNow;
      expect(fleet.applyCalls).toBe(1);
    }),
  );
  it.effect("remembers failures only for steps that actually started", () =>
    Effect.gen(function* () {
      const fleet = makeFleet();
      fleet.failOnce.add("home@2.90.0");
      const { update, baseDir } = yield* setup(fleet);
      yield* update.check;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const state = yield* decodeFailed(
        yield* fs.readFileString(path.join(config.stateDir, "opencodex-update.json")),
      );
      expect(state.failedTargets).toEqual({ "": "2.90.0" });
    }),
  );
});
