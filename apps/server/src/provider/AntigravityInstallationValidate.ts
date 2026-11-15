import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  type AntigravityExecutable,
  installationError,
  isAcpProcessExitedError,
  isInstallationError,
  LARGE_PAGE_KERNEL_MESSAGE,
} from "./AntigravityInstallationRecords.ts";

/** Starts a candidate runtime in a throwaway profile and checks it is the release it claims. */
export function makeAntigravityValidator(deps: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { fs, path, crypto, spawner, platform, environment } = deps;
  return Effect.fn("AntigravityInstallation.validate")(
    function* (executable: AntigravityExecutable, expectedVersion: string) {
      const validationScope = yield* Effect.scope;
      const profileDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "goat-antigravity-validate-" }),
        (directory) =>
          fs.remove(directory, { recursive: true, force: true }).pipe(
            // Windows may retain DLL handles briefly after taskkill returns.
            Effect.retry({
              times: platform === "win32" ? 10 : 0,
              schedule: Schedule.spaced("100 millis"),
              while: (error) =>
                error.reason._tag === "PermissionDenied" ||
                error.reason._tag === "Busy" ||
                error.reason._tag === "Unknown",
            }),
            Effect.orDie,
          ),
      );
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        platform,
        baseEnv: environment,
        // A shallow scoped profile cleans up unpacked files within Windows' path limit.
        tempDirectory: profileDirectory,
      });
      const runtime = yield* makeAntigravityAcpRuntime({
        runtimeVersion: expectedVersion,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd: profileDirectory,
          baseEnv: environment,
        }),
        cwd: profileDirectory,
        childProcessSpawner:
          platform === "win32"
            ? ChildProcessSpawner.make(
                Effect.fnUntraced(function* (command) {
                  const child = yield* spawner.spawn(command);
                  // Stop PyInstaller's tree before ACP closes pipes; after launcher exit, taskkill cannot reach children holding DLLs open.
                  yield* Scope.addFinalizer(
                    validationScope,
                    child.kill({ forceKillAfter: "1 second" }).pipe(Effect.orDie),
                  );
                  return child;
                }),
              )
            : spawner,
      });
      const initialized = yield* runtime.initialize();
      if (
        (executable.harnessPath === null
          ? initialized.agentInfo?.name !== "Antigravity ACP Server"
          : initialized.agentInfo?.name !== "antigravity-acp") ||
        initialized.agentInfo?.version !== expectedVersion ||
        // Antigravity 1.1.1 may report protocol 2 with legacy ACP; choose wire format from the response shape.
        (initialized.protocolVersion !== 1 && initialized.protocolVersion !== 2) ||
        initialized.agentCapabilities?.loadSession !== true ||
        !initialized.agentCapabilities.sessionCapabilities?.resume ||
        !initialized.agentCapabilities.auth?.logout ||
        !initialized.authMethods?.some((method) => method.id === "oauth-personal")
      ) {
        return yield* installationError(
          "verify",
          "The downloaded runtime did not identify as the expected Google Antigravity release.",
        );
      }
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.mapError((cause) => {
      if (isInstallationError(cause)) return cause;
      const stderr = isAcpProcessExitedError(cause) ? (cause.stderr ?? "") : "";
      const detail = /\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/.test(stderr)
        ? "Antigravity requires IPv6 socket support. Enable IPv6 in this environment. On WSL, remove ipv6.disable=1 from .wslconfig and run wsl --shutdown."
        : /page-size\.cc|Compile-time page size does not match/.test(stderr)
          ? LARGE_PAGE_KERNEL_MESSAGE
          : "The downloaded Antigravity runtime could not start in this environment.";
      return installationError("verify", detail, cause);
    }),
  );
}
