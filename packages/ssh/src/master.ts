import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  healthySshMaster,
  hasUserSshSharing,
  measureSshReconnectStep,
  resolveSshCommand,
  runSshCommand,
  SshConnectionSharing,
  SshReconnectCost,
  SSH_DIAGNOSTIC_ARGS,
  SSH_KEEPALIVE_ARGS,
  sshDiagnosticChunks,
  targetConnectionKey,
} from "./command.ts";
import { makeOwnedSshTunnelCommand } from "./tunnelOwner.ts";

export const ensureSshMaster = Effect.fn("ssh/master.ensure")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
  ownerScope: Scope.Scope,
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;
  const sharing = yield* SshConnectionSharing;
  const configuration = sharing?.configurations.get(target.alias);
  // Without an effective configuration we cannot safely override the user's sharing policy.
  if (
    sharing === null ||
    configuration === undefined ||
    !/^hostname /mu.test(configuration) ||
    !/^controlmaster (?:false|no)$/mu.test(configuration) ||
    hasUserSshSharing(configuration)
  )
    return;
  if (yield* healthySshMaster(target)) return;
  const key = targetConnectionKey(target);
  const previous = sharing.masters.get(key);
  if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void);
  const scope = yield* Scope.fork(ownerScope, "sequential");
  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    // macOS TMPDIR can leave no room for OpenSSH's temporary socket name.
    // mkdtemp creates a fresh private directory rather than trusting a shared fixed path.
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: "/tmp",
      prefix: "goat-ssh-runtime-",
    });
    yield* fs.chmod(directory, 0o700);
    const uid = yield* HostProcess.UserId;
    const info = yield* fs.stat(directory);
    if (uid === undefined || Option.getOrUndefined(info.uid) !== uid)
      return yield* Effect.fail("control-directory-owner-mismatch");
    // The effective config includes ProxyJump/ProxyCommand and every selected identity.
    const hash = Hex.encode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(`${key}\u0000${configuration}`)),
    ).slice(0, 12);
    const socket = path.join(directory, hash);
    // OpenSSH binds <ControlPath>.<16 random chars> before rename; reserve its suffix
    // and the terminating NUL within macOS's 104-byte sun_path (Linux allows 108).
    if (new TextEncoder().encode(socket).length + 17 >= 104)
      return yield* Effect.fail("control-path-too-long");
    const environment = yield* buildSshChildEnvironment({
      ...auth,
      askpassDirectory: path.join(directory, "t3code-ssh-askpass"),
    });
    const executable = yield* resolveSshCommand;
    const host = yield* buildSshHostSpecEffect(target);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      makeOwnedSshTunnelCommand(
        platform,
        executable,
        [
          ...SSH_DIAGNOSTIC_ARGS,
          ...baseSshArgs(target, {
            batchMode: auth.batchMode ?? (auth.interactiveAuth ? "no" : "yes"),
          }),
          ...SSH_KEEPALIVE_ARGS,
          "-M",
          "-N",
          "-S",
          socket,
          "-o",
          "ControlPersist=no",
          "--",
          host,
        ],
        { forceKillAfter: 2_000, env: environment, extendEnv: true },
        directory,
      ),
    );
    const cost = yield* SshReconnectCost;
    if (cost?.active) {
      cost.spawns++;
      cost.mastersStarted = (cost.mastersStarted ?? 0) + 1;
    }
    yield* Effect.addFinalizer(() =>
      child.kill({ killSignal: "SIGTERM", forceKillAfter: 2_000 }).pipe(Effect.ignore),
    );
    const ready = yield* Deferred.make<void>();
    yield* sshDiagnosticChunks(child.stderr, (line) => {
      if (line.startsWith("debug1: Entering interactive session."))
        Deferred.doneUnsafe(ready, Effect.void);
    }).pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
    yield* Effect.raceFirst(
      Deferred.await(ready),
      child.exitCode.pipe(Effect.andThen(Effect.fail("master-exited"))),
    );
    yield* runSshCommand(target, {
      ...auth,
      preHostArgs: ["-S", socket, "-O", "check"],
      timeoutMs: 5_000,
    });
    const master = { configuration, socket, process: child, scope };
    sharing.masters.set(key, master);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (sharing.masters.get(key) === master) sharing.masters.delete(key);
      }),
    );
  }).pipe(
    (effect) => measureSshReconnectStep("ssh/master.start", effect),
    Effect.provideService(Scope.Scope, scope),
    Effect.timeout("60 seconds"),
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void))),
    Effect.catch((cause) => Effect.logDebug("ssh.master.fallback", { alias: target.alias, cause })),
  );
});
