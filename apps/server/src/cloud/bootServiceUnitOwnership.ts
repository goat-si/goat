import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type { BootServiceManager } from "./bootService.ts";
import { BootServiceCommandError } from "./bootServiceErrors.ts";
import { bootServiceBaseDirOf } from "./systemdValues.ts";

export interface OwnedLegacyUnit {
  readonly manager: BootServiceManager;
  readonly contents: string;
}

export function makeBootServiceUnitOwnership(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
) {
  const servesThisHome = (servedBaseDir: string | undefined) =>
    servedBaseDir !== undefined && path.resolve(servedBaseDir) === path.resolve(baseDir);

  const readLegacyUnit = Effect.fn("cloud.boot_service.read_legacy_unit")(function* (
    legacyManager: BootServiceManager | undefined,
  ) {
    if (legacyManager === undefined) return Option.none<OwnedLegacyUnit>();
    const unit = yield* readUnit(legacyManager.unitPath);
    return unit._tag === "Owned"
      ? Option.some<OwnedLegacyUnit>({ manager: legacyManager, contents: unit.contents })
      : Option.none<OwnedLegacyUnit>();
  });

  /**
   * `goat.service` is one unit per user. A file that serves another home belongs
   * to that home; this command must not stop, replace, or report it as ours.
   */
  const readUnit = Effect.fn("cloud.boot_service.read_unit")(function* (unitPath: string) {
    const contents = yield* fs.readFileString(unitPath).pipe(Effect.option);
    return classifyUnit(Option.getOrUndefined(contents));
  });

  const classifyUnit = (contents: string | undefined) => {
    if (contents === undefined) return { _tag: "Absent" as const };
    const servedBaseDir = bootServiceBaseDirOf(contents);
    return servesThisHome(servedBaseDir)
      ? { _tag: "Owned" as const, contents }
      : { _tag: "Foreign" as const, baseDir: servedBaseDir };
  };

  const checkUnitOwner = (unit: ReturnType<typeof classifyUnit>) =>
    unit._tag === "Foreign"
      ? Effect.fail(
          new BootServiceCommandError({
            step: `the service for this user belongs to ${unit.baseDir ?? "another GOAT home"}`,
          }),
        )
      : Effect.succeed(unit._tag === "Owned");

  const checkInstallDestination = Effect.fn("cloud.boot_service.check_install_destination")(
    function* (destination: string) {
      const contents = yield* fs.readFileString(destination).pipe(
        Effect.asSome,
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          (cause) =>
            fs.readLink(destination).pipe(
              Effect.matchEffect({
                onSuccess: () => Effect.fail(cause),
                onFailure: (linkError) =>
                  linkError.reason._tag === "NotFound"
                    ? Effect.succeedNone
                    : Effect.fail(linkError),
              }),
            ),
        ),
        Effect.mapError(
          (cause) =>
            new BootServiceCommandError({ step: `reading the unit at ${destination}`, cause }),
        ),
      );
      return yield* checkUnitOwner(classifyUnit(Option.getOrUndefined(contents)));
    },
  );

  return { servesThisHome, readUnit, readLegacyUnit, checkInstallDestination, checkUnitOwner };
}
