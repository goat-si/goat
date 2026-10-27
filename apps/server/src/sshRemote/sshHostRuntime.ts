import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import type * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";

import type { SshRemoteDispatchError } from "./SshRemoteDispatch.ts";

type ScriptOutput = { readonly stdout: string; readonly stderr: string };

/** Host-alias operations on a machine's GOAT runtime, outside any agent's remote session. */
export interface HostRuntimeAdapters {
  /** Runs a POSIX sh script on a known SSH host alias, the way runRemoteScript does. */
  readonly runHostScript: (input: {
    readonly host: string;
    readonly script: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<ScriptOutput, SshRemoteDispatchError>;
  /**
   * The installed GOAT executable of the runtime this server's SSH connection is attached to,
   * verified on the host; undefined when nothing usable is attached. Never starts or installs.
   */
  readonly provisionedRuntimeExecutable: (
    host: string,
  ) => Effect.Effect<string | undefined, SshRemoteDispatchError>;
  /**
   * Attaches to, or provisions, the host's GOAT runtime as an agent connection does, without
   * replacing a running one or minting a pairing token. False while it is pending or has no
   * usable executable.
   */
  readonly ensureRuntime: (host: string) => Effect.Effect<boolean, SshRemoteDispatchError>;
}

export const makeHostRuntime = (input: {
  readonly manager: SshTunnel.SshEnvironmentManagerShape;
  readonly resolveHost: (
    host: string,
  ) => Effect.Effect<DesktopSshEnvironmentTarget, SshRemoteDispatchError>;
  readonly withRuntime: <A, E>(
    effect: Effect.Effect<A, E, SshTunnel.SshEnvironmentEffectContext>,
  ) => Effect.Effect<A, E>;
  readonly sshFailed: (
    alias: string,
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, SshRemoteDispatchError, R>;
  readonly readyCloudTarget: (
    target: DesktopSshEnvironmentTarget,
    wake: boolean,
  ) => Effect.Effect<void, SshRemoteDispatchError>;
  readonly runRemoteScript: (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly script: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<ScriptOutput, SshRemoteDispatchError>;
}): HostRuntimeAdapters => {
  const lookup = (target: DesktopSshEnvironmentTarget) => {
    const resolve = input.manager.provisionedRuntimeExecutable;
    // A manager without the lookup has no verified executable to offer.
    return resolve === undefined
      ? Effect.sync((): string | undefined => undefined)
      : input.withRuntime(resolve(target)).pipe(input.sshFailed(target.alias));
  };
  return {
    runHostScript: Effect.fn("SshRemoteDispatch.runHostScript")(function* (script) {
      const target = yield* input.resolveHost(script.host);
      return yield* input.runRemoteScript({
        target,
        script: script.script,
        timeoutMs: script.timeoutMs,
      });
    }),
    provisionedRuntimeExecutable: Effect.fn("SshRemoteDispatch.provisionedRuntimeExecutable")(
      function* (host) {
        return yield* lookup(yield* input.resolveHost(host));
      },
    ),
    ensureRuntime: Effect.fn("SshRemoteDispatch.ensureRuntime")(function* (host) {
      const target = yield* input.resolveHost(host);
      // Never wakes a stopped cloud machine: only explicit agent work does.
      yield* input.readyCloudTarget(target, false);
      const ensured = yield* input
        .withRuntime(
          input.manager.ensureEnvironment(target, {
            keyOnly: true,
            issuePairingToken: false,
            reuseWhileRefreshPending: true,
          }),
        )
        .pipe(input.sshFailed(target.alias));
      if ("type" in ensured) return false;
      return (yield* lookup(target)) !== undefined;
    }),
  };
};
