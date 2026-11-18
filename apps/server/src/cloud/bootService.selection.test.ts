import { makeHarness } from "./bootService.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const pendingState = JSON.stringify({
  protocol: SERVICE_LAUNCHER_PROTOCOL,
  activeVersion: "1.2.3",
  update: {
    id: "u",
    fromVersion: "1.2.3",
    targetVersion: "1.2.4",
    dbPath: "/tmp/state.sqlite",
    status: "pending",
  },
});

it.layer(NodeServices.layer)("boot service selection", (it) => {
  it.effect("a pending remote update whose unit is gone names the command that finishes it", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, baseDir } = yield* makeHarness();
      yield* fs.makeDirectory(yield* Effect.map(Path.Path, (path) => path.dirname(statePath)), {
        recursive: true,
      });
      yield* fs.writeFileString(statePath, pendingState);

      const error = yield* service.install().pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceUpdatePendingError");
      expect(
        error._tag === "BootServiceUpdatePendingError" ? error.recoveryCommand : undefined,
      ).toBe(
        `GOAT_HOME='${baseDir}' '${baseDir}/runtime/goat/versions/1.2.3/goat' __service-launcher`,
      );
      expect(yield* fs.readFileString(statePath)).toBe(pendingState);
    }),
  );

  it.effect("an install leaves no selection lease behind", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { service, fs, statePath } = yield* makeHarness();
      yield* service.install();
      yield* service.install({ start: false });
      const runtimeEntries = yield* fs.readDirectory(path.dirname(statePath));
      expect(runtimeEntries.filter((entry) => entry.includes(".selection-lock"))).toEqual([]);
    }),
  );

  it.effect("rejects a per-user unit installed by a different home after the initial read", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { service, makeService, fs, home } = yield* makeHarness();
      const { unitPath } = yield* service.status;
      const otherHome = path.join(home, ".other");
      let installedUnit: string | undefined;
      const second = yield* makeService(undefined, "1.2.3", otherHome).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (filePath, encoding) =>
            fs.readFileString(filePath, encoding).pipe(
              Effect.tapError(() =>
                filePath !== unitPath || installedUnit !== undefined
                  ? Effect.void
                  : Effect.gen(function* () {
                      yield* service.install({ start: false });
                      installedUnit = yield* fs.readFileString(unitPath);
                    }).pipe(Effect.orDie),
              ),
            ),
        }),
      );

      const error = yield* second.install({ start: false }).pipe(Effect.flip);
      expect(installedUnit).toBeDefined();
      expect(error).toMatchObject({ _tag: "BootServiceCommandError" });
      expect(yield* fs.readFileString(unitPath)).toBe(installedUnit);
      expect(yield* fs.exists(path.join(otherHome, "runtime", "service-state.json"))).toBe(false);
    }),
  );

  it.effect("leaves selection untouched when the destination unit cannot be read", () =>
    Effect.gen(function* () {
      const { service, fs, statePath } = yield* makeHarness();
      const { unitPath } = yield* service.status;
      yield* fs.makeDirectory(unitPath, { recursive: true });

      yield* service.install({ start: false }).pipe(Effect.flip);

      expect(yield* fs.exists(statePath)).toBe(false);
      expect((yield* fs.stat(unitPath)).type).toBe("Directory");
    }),
  );
});
