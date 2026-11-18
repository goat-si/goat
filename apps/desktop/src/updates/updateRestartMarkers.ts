import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@goat/contracts";
import {
  SHARED_HOME_DESKTOP_UPDATE_MARKER,
  SHARED_HOME_DESKTOP_UPDATE_TTL_SECONDS,
} from "@goat/shared/desktopAppServer";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-updates");

export const makeUpdateRestartMarkers = Effect.fn("desktop.updates.makeRestartMarkers")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const { path, baseDir, stateDir, homeDirectory } = environment;
    const directory = path.join(baseDir, "runtime");
    const tunnelHandoff = path.join(directory, DESKTOP_UPDATE_RESTART_MARKER_FILE);
    const sharedHomeMarker = path.join(directory, SHARED_HOME_DESKTOP_UPDATE_MARKER);
    const written = yield* Ref.make<string | undefined>(undefined);
    const processMarker = `${sharedHomeMarker}.${process.pid}.next`;

    const write = Effect.fn("desktop.updates.writeRestartMarkers")(
      function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(tunnelHandoff, "");
        if (path.relative(path.join(baseDir, "userdata"), stateDir) !== "") return;
        const sshHome = path.join(homeDirectory, GOAT_HOME_DIR_NAME);
        if (path.relative(sshHome, baseDir) !== "") {
          const real = yield* fs.realPath(baseDir).pipe(Effect.option);
          const shared = yield* fs.realPath(sshHome).pipe(Effect.option);
          if (
            Option.isNone(real) ||
            Option.isNone(shared) ||
            path.relative(real.value, shared.value) !== ""
          )
            return;
        }
        const now = yield* Clock.currentTimeMillis;
        const expiry = Math.floor(now / 1000) + SHARED_HOME_DESKTOP_UPDATE_TTL_SECONDS;
        const value = `${expiry} ${process.pid}-${now}\n`;
        yield* fs.writeFileString(processMarker, value).pipe(
          Effect.andThen(fs.rename(processMarker, sharedHomeMarker)),
          Effect.tap(() => Ref.set(written, value)),
          Effect.ensuring(fs.remove(processMarker, { force: true }).pipe(Effect.ignore)),
        );
      },
      Effect.tapError((error) =>
        logWarning("Could not write the desktop update handoff marker.", { errorTag: error._tag }),
      ),
      Effect.ignore,
    );

    const remove = Effect.fn("desktop.updates.removeRestartMarkers")(function* () {
      yield* fs.remove(tunnelHandoff, { force: true }).pipe(Effect.ignore);
      const value = yield* Ref.getAndSet(written, undefined);
      if (value === undefined) return;
      const current = yield* fs.readFileString(sharedHomeMarker).pipe(Effect.option);
      if (Option.isSome(current) && current.value === value) {
        yield* fs.remove(sharedHomeMarker, { force: true }).pipe(Effect.ignore);
      }
    });

    return {
      directory,
      writeUpdateRestartMarker: write(),
      removeUpdateRestartMarker: remove(),
    };
  },
);
