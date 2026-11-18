import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { serviceUnitFromEnvironment } from "./serviceUnitRepoint.ts";

it.layer(NodeServices.layer)("the service unit the launcher repoints", (it) => {
  const fakeBusctl = (reply: string, exitCode = 0) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-unit-" });
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(
        path.join(bin, "busctl"),
        `#!/bin/sh\nprintf '%s\\n' '${reply}'\nexit ${exitCode}\n`,
      );
      yield* fs.chmod(path.join(bin, "busctl"), 0o755);
      return { root, bin, home: path.join(root, "home") };
    });

  it.effect("is the unit the systemd manager loads, when environment.d moves XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const managerHome = "/home/sam";
      const managerUnitDir = path.join(managerHome, ".config", "systemd", "user");
      const reply = JSON.stringify({
        type: "as",
        data: [`${managerUnitDir}.control`, managerUnitDir, "/usr/lib/systemd/user"],
      });
      const { bin, home } = yield* fakeBusctl(reply);
      const unit = yield* Effect.promise(async () =>
        serviceUnitFromEnvironment({
          PATH: bin,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "service-config"),
          GOAT_BOOT_SERVICE_UNIT: "goat.service",
        }),
      );
      assert.equal(unit?.path, path.join(managerUnitDir, "goat.service"));
    }),
  );

  it.effect("falls back to XDG_CONFIG_HOME when busctl fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { bin, home } = yield* fakeBusctl("", 1);
      const unit = yield* Effect.promise(async () =>
        serviceUnitFromEnvironment({
          PATH: bin,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "cfg"),
          GOAT_BOOT_SERVICE_UNIT: "goat.service",
        }),
      );
      assert.equal(unit?.path, path.join(home, "cfg", "systemd", "user", "goat.service"));
    }),
  );
});
