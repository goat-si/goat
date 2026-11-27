import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import type { SshAuthOptions } from "./auth.ts";
import { hasUserSshSharing, runSshCommand } from "./command.ts";

const joinsUserMaster = (configuration: string | undefined, platform: NodeJS.Platform) =>
  platform !== "win32" && configuration !== undefined && hasUserSshSharing(configuration);

const hasControlPath = (configuration: string) =>
  configuration.split(/\r?\n/u).some((line) => {
    const [key, value] = line.trim().split(/\s+/u);
    return key?.toLowerCase() === "controlpath" && value !== undefined && value !== "none";
  });

/**
 * With sharing in the user's config (Pen's ControlMaster auto + ControlPath), a forward joins a
 * live master instead of running its own ProxyCommand. It never becomes the master: one it started
 * would keep its ProxyCommand in this forward's process group, which closing the forward kills.
 */
export const forwardSharingArgs = (
  configuration: string | undefined,
  platform: NodeJS.Platform,
): ReadonlyArray<string> =>
  joinsUserMaster(configuration, platform)
    ? ["-o", "ControlMaster=no"]
    : ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"];

/** A master keeps the forwards its clients asked for after they exit, so closing one cancels it. */
export const cancelForwardInUserMaster = Effect.fn("ssh/tunnel.cancelForwardInUserMaster")(
  function* (input: {
    readonly scope: Scope.Scope;
    readonly target: DesktopSshEnvironmentTarget;
    readonly auth: SshAuthOptions;
    readonly forward: string;
    readonly configuration: string | undefined;
    readonly platform: NodeJS.Platform;
  }) {
    if (!joinsUserMaster(input.configuration, input.platform)) return;
    if (input.configuration === undefined || !hasControlPath(input.configuration)) return;
    const services = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    yield* Scope.addFinalizer(
      input.scope,
      runSshCommand(input.target, {
        ...input.auth,
        preHostArgs: ["-O", "cancel", "-L", input.forward],
        timeoutMs: 2_000,
      }).pipe(Effect.provideContext(services), Effect.ignore),
    );
  },
);
