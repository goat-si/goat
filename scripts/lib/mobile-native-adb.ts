import * as HostProcess from "@goat/shared/HostProcess";
import { isCommandAvailable } from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class NativeClientError extends Schema.TaggedError<NativeClientError>()(
  "NativeClientError",
  { message: Schema.String },
) {}

export const resolveAdb = Effect.gen(function* () {
  if (yield* isCommandAvailable("adb")) return "adb";
  const environment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const executable = (yield* HostProcess.Platform) === "win32" ? "adb.exe" : "adb";
  for (const sdk of [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME]) {
    if (!sdk) continue;
    const candidate = path.join(sdk, "platform-tools", executable);
    if (yield* isCommandAvailable(candidate)) return candidate;
  }
  return yield* new NativeClientError({
    message:
      "adb was not found on PATH or in ANDROID_SDK_ROOT/ANDROID_HOME. Install Android SDK platform-tools.",
  });
});
