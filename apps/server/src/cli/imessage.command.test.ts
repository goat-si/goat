import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Command } from "effect/cli";

import { imessageCommand, readImessageFile } from "./imessage.ts";

it.layer(NodeServices.layer)("goat imessage command line", (it) => {
  // The handler tests cannot see flag parsing; the default ceiling must be reachable without flags.
  it.effect("enable without --full-access keeps the approval-required ceiling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-imessage-cli-test-" });
      yield* Command.runWith(imessageCommand, { version: "0.0.0" })([
        "enable",
        "--base-dir",
        baseDir,
        "--allow",
        "+15550000000",
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );
      const settings = yield* Effect.promise(() => readImessageFile(baseDir + "/userdata"));
      expect(settings?.enabled).toBe(true);
      expect(settings?.owner.runtimeModeCeiling).toBe("approval-required");
    }),
  );
});
