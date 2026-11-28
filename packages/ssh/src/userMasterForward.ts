import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import type { SshAuthOptions } from "./auth.ts";
import { runSshCommand } from "./command.ts";

// ssh -G prints ControlPath expanded; one that still holds % or spaces is not passed back as given.
const userControlPath = (configuration: string | undefined, platform: NodeJS.Platform) => {
  if (platform === "win32" || configuration === undefined) return undefined;
  for (const line of configuration.split(/\r?\n/u)) {
    const path = /^controlpath\s+(\S+)$/iu.exec(line.trim())?.[1];
    if (path !== undefined) return path === "none" || path.includes("%") ? undefined : path;
  }
  return undefined;
};

/**
 * With a ControlPath in the user's config (Pen sets one), a forward joins that live master instead
 * of running its own ProxyCommand. It never becomes the master: one it started would keep its
 * ProxyCommand in this forward's process group, which closing the forward kills.
 */
export const forwardSharingArgs = (
  configuration: string | undefined,
  platform: NodeJS.Platform,
): ReadonlyArray<string> => {
  const socket = userControlPath(configuration, platform);
  return socket === undefined
    ? ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"]
    : ["-o", "ControlMaster=no", "-S", socket];
};

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
    const socket = userControlPath(input.configuration, input.platform);
    if (socket === undefined) return;
    const services = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    // OpenSSH cancels only a forward with this exact listen and connect address.
    yield* Scope.addFinalizer(
      input.scope,
      runSshCommand(input.target, {
        ...input.auth,
        preHostArgs: ["-S", socket, "-O", "cancel", "-L", input.forward],
        timeoutMs: 2_000,
      }).pipe(Effect.provideContext(services), Effect.ignore),
    );
  },
);
