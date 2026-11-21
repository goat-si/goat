import * as HostProcess from "@goat/shared/HostProcess";
import { isCommandAvailable } from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class NativeClientError extends Schema.TaggedError<NativeClientError>()(
  "NativeClientError",
  { message: Schema.String },
) {}

export const androidSdk = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const executable = (yield* HostProcess.Platform) === "win32" ? "adb.exe" : "adb";
  const candidates = [
    environment.ANDROID_HOME?.trim(),
    environment.ANDROID_SDK_ROOT?.trim(),
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
    path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk"),
  ];
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const skipped: string[] = [];
  for (const root of candidates) {
    if (!root) continue;
    if (yield* exists(path.join(root, "platform-tools", executable))) {
      yield* Console.error(
        `Android SDK selected: ${root}; skipped: ${skipped.join(", ") || "none"}`,
      );
      return root;
    }
    skipped.push(`${root} (${(yield* exists(root)) ? "no platform-tools" : "missing dir"})`);
  }
  yield* Console.error(`Android SDK unavailable; skipped: ${skipped.join(", ") || "none"}`);
  return undefined;
});

export const resolveAdb = Effect.gen(function* () {
  if (yield* isCommandAvailable("adb")) return "adb";
  const path = yield* Path.Path;
  const executable = (yield* HostProcess.Platform) === "win32" ? "adb.exe" : "adb";
  const sdk = yield* androidSdk;
  if (sdk) return path.join(sdk, "platform-tools", executable);
  return yield* new NativeClientError({
    message:
      "adb was not found on PATH or in ANDROID_SDK_ROOT/ANDROID_HOME. Install Android SDK platform-tools.",
  });
});
