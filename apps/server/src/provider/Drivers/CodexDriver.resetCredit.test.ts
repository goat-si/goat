import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

it.layer(layerTest)("CodexDriver reset credits", (it) => {
  it.effect("a redemption refused at the account limit tells the person why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const coordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      for (let index = 0; index < ResetCreditCoordinator.MAX_TRACKED_ACCOUNTS; index += 1) {
        yield* coordinator
          .redeem(`${root}/uncertain-${index}`, () => Effect.fail("timed out" as const))
          .pipe(Effect.result);
      }
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("reset-credit-limit"),
        displayName: "Codex reset credit test",
        enabled: true,
        environment: [],
        config: { ...CodexDriver.defaultConfig(), homePath: `${root}/home` },
      }).pipe(
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, root),
      );
      const error = yield* instance.consumeResetCredit!().pipe(Effect.flip);
      expect(error.detail).toBe(new ResetCreditCoordinator.ResetCreditAccountLimitError().message);
    }).pipe(Effect.scoped),
  );
});
