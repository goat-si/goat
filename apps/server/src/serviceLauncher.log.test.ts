import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { renderBootServicePlist, renderBootServiceUnit } from "./cloud/bootService.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";

it.layer(NodeServices.layer)("service log bound", (it) => {
  it.effect.each(["systemd", "launchd"] as const)(
    "a %s launcher empties its oversized append log at start and keeps a copy",
    (manager) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-log-" });
        const plan = {
          program: [path.join(root, "runtime/goat/versions/1.0.0/goat"), "__service-launcher"],
          baseDir: root,
          logPath: path.join(root, "userdata", "logs", "boot-service.log"),
          unitPath: path.join(root, "unit"),
        };
        yield* fs.writeFileString(
          plan.unitPath,
          manager === "systemd"
            ? renderBootServiceUnit(plan)
            : renderBootServicePlist(plan, { homeDir: root, environmentPath: "" }),
        );
        const oversized = 10 * 1024 * 1024 + 1;
        yield* fs.makeDirectory(path.dirname(plan.logPath), { recursive: true });
        yield* fs.writeFileString(plan.logPath, "");
        yield* fs.truncate(plan.logPath, oversized);
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime/goat/versions/1.0.0"),
          "process.exit(0);",
        );
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            serviceUnit: { path: plan.unitPath, reload: () => Promise.resolve() },
          },
        );
        yield* Effect.promise(() => launcher.run().catch(() => undefined));

        assert.equal(Number((yield* fs.stat(plan.logPath)).size), 0);
        assert.equal(Number((yield* fs.stat(plan.logPath + ".1")).size), oversized);
      }),
  );
});
