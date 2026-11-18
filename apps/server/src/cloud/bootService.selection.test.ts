import { makeHarness } from "./bootService.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_RESTART_PENDING_FILE } from "./serviceProtocol.ts";

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
  it.effect.each([
    ["accepts the selected runtime on Linux", "linux", undefined],
    ["accepts the selected runtime on macOS", "darwin", undefined],
    ["rejects an endpoint reporting the wrong version", "linux", "1.2.4"],
  ] as const)(
    "restart from the newer CLI after rollback %s",
    ([_scenario, platform, reportedVersion]) =>
      Effect.gen(function* () {
        const { makeService, fs, baseDir, statePath, commands, control } =
          yield* makeHarness(platform);
        const path = yield* Path.Path;
        const newer = yield* makeService(undefined, "1.2.4");
        const { unitPath } = yield* newer.install({ start: false });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        const update = { id: "u", fromVersion: "1.2.3", targetVersion: "1.2.4" };
        yield* fs.writeFileString(
          statePath,
          JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.2.4",
            update: { ...update, status: "committed" },
            probation: { dbPath, deadline: 1, rollbackReason: "probation-exit:42" },
          }),
        );
        control.stateOnActivate = JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.2.3",
          update: { ...update, status: "rolled-back", reason: "probation-exit:42" },
        });
        if (reportedVersion !== undefined) control.reportedVersion = reportedVersion;
        commands.length = 0;

        const clock = yield* Clock.Clock;
        const waitingOrDone = yield* Deferred.make<void>();
        const restart = yield* newer.restart.pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: (duration) =>
              Duration.toMillis(duration) === 200
                ? Deferred.succeed(waitingOrDone, undefined).pipe(
                    Effect.andThen(clock.sleep(Duration.seconds(61))),
                  )
                : clock.sleep(duration),
          }),
          Effect.ensuring(Deferred.succeed(waitingOrDone, undefined)),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(waitingOrDone);
        yield* TestClock.adjust("61 seconds");
        const result = yield* Fiber.join(restart);
        const starts = commands.filter(
          (command) =>
            command === "systemctl --user restart goat.service" ||
            command === `launchctl bootstrap gui/501 ${unitPath}`,
        );
        expect(control.readinessRequests).toBe(1);
        if (reportedVersion === undefined) {
          expect(result).toMatchObject({ _tag: "Success", success: "restarted" });
          expect(starts).toHaveLength(1);
        } else {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { step: "waiting for the service to answer" },
          });
        }
      }),
  );

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
      const { makeService, fs, statePath, service: original } = yield* makeHarness();
      const { unitPath } = yield* original.status;
      const pendingPath = path.join(path.dirname(statePath), SERVICE_RESTART_PENDING_FILE);
      const observed: boolean[][] = [];
      const service = yield* makeService().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, contents, options) =>
            Effect.gen(function* () {
              if (filePath === pendingPath) {
                observed.push(
                  yield* Effect.all([
                    fs.exists(`${statePath}.selection-lock`),
                    fs.exists(`${unitPath}.selection-lock`),
                  ]),
                );
              }
              yield* fs.writeFileString(filePath, contents, options);
            }),
        }),
      );
      yield* service.install();
      yield* service.install({ start: false });
      expect(observed).toEqual([
        [true, true],
        [true, true],
      ]);
      const runtimeEntries = yield* fs.readDirectory(path.dirname(statePath));
      const unitEntries = yield* fs.readDirectory(path.dirname(unitPath));
      expect(runtimeEntries.filter((entry) => entry.includes(".selection-lock"))).toEqual([]);
      expect(unitEntries.filter((entry) => entry.includes(".selection-lock"))).toEqual([]);
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
