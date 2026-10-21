// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalDateInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ServerSelfUpdateError } from "@goat/contracts";
import { CLI_RELEASE_BASE_URL_ENV } from "@goat/shared/cliRelease";
import {
  compareRuntimeProtocols,
  servedRuntimeProtocolRanges,
} from "@goat/shared/sshRuntimeProtocol";
import { REMOTE_RUNTIME_STATE_KEY } from "@goat/ssh/command";
import {
  buildRemoteHostDownloadScript,
  buildRemoteLaunchScript,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
} from "@goat/ssh/tunnel";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };
import { readSshReplacementRecord, SSH_REPLACEMENT_RECORD_FILE } from "../cli/sshHelper.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as RuntimeDrain from "../runtimeDrain.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SSH_REPLACEMENT_ID_ENV } from "../serverOwnerLock.ts";
import { automaticUpdateChannel, arbitrateAutomaticTargets } from "./autoUpdatePolicy.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import { bashScriptArg, defaultWindowsGitBash } from "./sshRuntimeGitBash.ts";
import { windowsJobCommand } from "./sshRuntimeWindowsJob.ts";

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 30_000;
// Far beyond the longest drain window plus readiness; only a script stuck before the drain is
// still running when this expires.
const DETACHED_TIMEOUT_MS = 30 * 60_000;

export interface SshRuntimeProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The host commands an SSH runtime runs to replace itself. `runDetached` starts its own
 * session, so the drain that stops this server cannot take the replacement down with it.
 */
export class SshRuntimeHost extends Context.Service<
  SshRuntimeHost,
  {
    readonly run: (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
    }) => Effect.Effect<SshRuntimeProcessResult>;
    readonly runDetached: (input: {
      /** `/bin/sh` on POSIX, Git for Windows `bash.exe` on Windows. */
      readonly shell: string;
      readonly script: string;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly cwd: string;
    }) => Effect.Effect<SshRuntimeProcessResult>;
    readonly sha256: (file: string) => Effect.Effect<string | undefined>;
    readonly readText: (file: string) => Effect.Effect<string | undefined>;
    /** Renames a directory out of the way and returns where it went. */
    readonly moveAside: (dir: string) => Effect.Effect<string | undefined>;
    readonly remove: (dir: string) => Effect.Effect<void>;
  }
>()("goat/cloud/sshRuntimeAutoUpdate/SshRuntimeHost") {}

const collect = (child: NodeChildProcess.ChildProcess) =>
  new Promise<SshRuntimeProcessResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "" }));
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
};

const stopProcessTree = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
  if (HostProcess.Platform.defaultValue() !== "win32") {
    if (child.pid !== undefined) signalGroup(child.pid, signal);
    return;
  }
  // libuv keeps this process HANDLE: unlike taskkill /PID, it cannot select a reused PID.
  // The supervisor owns a kill-on-close job even after the command's parent shell exits.
  child.kill(signal);
};

const spawnOwnedCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions & { env: NodeJS.ProcessEnv },
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const owned =
    HostProcess.Platform.defaultValue() === "win32"
      ? await windowsJobCommand({ command, args, env: options.env })
      : { command, args, dispose: async () => {} };
  try {
    signal?.throwIfAborted();
    return {
      child: NodeChildProcess.spawn(owned.command, [...owned.args], options),
      dispose: owned.dispose,
    };
  } catch (error) {
    await owned.dispose();
    throw error;
  }
};

export const layerHost = Layer.succeed(SshRuntimeHost, {
  run: (input) =>
    Effect.callback<SshRuntimeProcessResult>((resume) => {
      // Its own process group, so a timeout or an interruption also stops the downloader the
      // install script waits on, and with it the install lock.
      const controller = new AbortController();
      const started = spawnOwnedCommand(
        input.command,
        input.args.map((arg) => bashScriptArg(input.command, arg)),
        {
          env: input.env,
          detached: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
        controller.signal,
      );
      // Done means every process holding the output has exited, which the leader alone does not
      // show: a shell can exit and leave its downloader running.
      let done = false;
      let bound: ReturnType<typeof setTimeout> | undefined;
      const closed = started
        .then(async ({ child, dispose }) => {
          const result = collect(child);
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(input.stdin ?? "");
          bound = setTimeout(() => {
            if (done || child.pid === undefined) return;
            stopProcessTree(child, "SIGTERM");
            setTimeout(() => {
              if (!done && child.pid !== undefined) stopProcessTree(child, "SIGKILL");
            }, 5_000).unref();
          }, input.timeoutMs);
          try {
            return await result;
          } finally {
            await dispose();
          }
        })
        .catch((error: unknown) => ({
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          done = true;
          clearTimeout(bound);
          return result;
        });
      void closed.then((result) => resume(Effect.succeed(result)));
      // Interruption waits for the group to end, so a server shutting down cannot drop the kill.
      return Effect.promise(async () => {
        controller.abort();
        const owned = await started.catch(() => undefined);
        clearTimeout(bound);
        if (owned === undefined) return;
        const { child } = owned;
        if (done || child.pid === undefined) return;
        stopProcessTree(child, "SIGTERM");
        const ended = await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        if (!ended) stopProcessTree(child, "SIGKILL");
        await closed;
      });
    }),
  runDetached: (input) =>
    Effect.callback<SshRuntimeProcessResult>((resume) => {
      const controller = new AbortController();
      const preparation = Promise.withResolvers<void>();
      const operation = (async () => {
        const dir = await NodeFS.promises.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "goat-runtime-update-"),
        );
        try {
          const scriptFile = NodePath.join(dir, "launch.sh");
          const stdoutFile = NodePath.join(dir, "stdout");
          const stderrFile = NodePath.join(dir, "stderr");
          await NodeFS.promises.writeFile(scriptFile, input.script, { mode: 0o600 });
          // Files, never pipes: the drain stops this server mid-script, and a write to a closed pipe
          // would kill the script before it releases the replacement lock and drain fence.
          const stdout = NodeFS.openSync(stdoutFile, "w", 0o600);
          const stderr = NodeFS.openSync(stderrFile, "w", 0o600);
          // Never killed from here: once it drains this server, the script and the supervisor it
          // starts own the host until the replacement answers or the previous version is restored.
          // Detached leaves the script outside libuv's kill-on-close job, so it outlives the drain.
          const scriptArg = bashScriptArg(input.shell, scriptFile);
          const { child, dispose } = await spawnOwnedCommand(
            input.shell,
            [scriptArg, ...input.args],
            {
              cwd: input.cwd,
              detached: true,
              windowsHide: true,
              env: input.env,
              stdio: ["ignore", stdout, stderr],
            },
            controller.signal,
          ).finally(() => {
            NodeFS.closeSync(stdout);
            NodeFS.closeSync(stderr);
          });
          // The detached process now owns the update. Cancellation can no longer stop it.
          if (child.pid !== undefined) preparation.resolve();
          const code = await new Promise<number | null>((resolve) => {
            child.once("error", () => resolve(null));
            child.once("close", resolve);
            // Still alive here means the script never drained this server: it is stuck before the
            // swap, so stopping it (its trap releases the replacement lock) cannot strand the host.
            const bound = setTimeout(() => {
              if (child.pid !== undefined) stopProcessTree(child, "SIGTERM");
            }, DETACHED_TIMEOUT_MS);
            bound.unref();
            child.once("close", () => clearTimeout(bound));
          });
          const read = (file: string) => NodeFS.promises.readFile(file, "utf8").catch(() => "");
          const result = { code, stdout: await read(stdoutFile), stderr: await read(stderrFile) };
          await dispose();
          return result;
        } finally {
          await NodeFS.promises.rm(dir, { recursive: true, force: true });
        }
      })();
      void operation.then(
        (result) => {
          preparation.resolve();
          resume(Effect.succeed(result));
        },
        (error) => {
          preparation.resolve();
          resume(Effect.die(error));
        },
      );
      return Effect.promise(async () => {
        controller.abort();
        // Before detach, wait for compilation and both temporary directories to be released.
        // After detach this is already resolved; the updater must outlive its former caller.
        await preparation.promise;
      });
    }),
  sha256: (file) =>
    Effect.promise(() =>
      NodeFS.promises
        .readFile(file)
        .then((bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex"))
        .catch(() => undefined),
    ),
  readText: (file) =>
    Effect.promise(() => NodeFS.promises.readFile(file, "utf8").catch(() => undefined)),
  moveAside: (dir) =>
    Effect.promise(async () => {
      const aside = NodePath.join(
        NodePath.dirname(dir),
        `.trash-unverified-${NodePath.basename(dir)}-${process.pid}-${Date.now()}`,
      );
      return NodeFS.promises.rename(dir, aside).then(
        () => aside,
        () => undefined,
      );
    }),
  remove: (dir) => Effect.promise(() => NodeFS.promises.rm(dir, { recursive: true, force: true })),
});

export class SshRuntimeAutoUpdate extends Context.Service<
  SshRuntimeAutoUpdate,
  {
    /**
     * This server runs in the user's default home, outside the desktop app, on a host
     * whose shell can replace it. Windows qualifies when Git for Windows bash is installed.
     */
    readonly supported: boolean;
    /** The shared SSH runtime's launch records name this process as their managed server. */
    readonly owned: Effect.Effect<boolean>;
    readonly isUpdating: Effect.Effect<boolean>;
    readonly failedTarget: Effect.Effect<string | undefined>;
    readonly prepare: (targetVersion: string) => Effect.Effect<void, ServerSelfUpdateError>;
    readonly activate: (
      targetVersion: string,
    ) => Effect.Effect<"requested" | "busy", ServerSelfUpdateError>;
    readonly clearPending: Effect.Effect<void>;
    /**
     * Arbitrates a client's automatic idle refresh against this runtime's own prepared target.
     * Requests that are not automatic (older clients, confirmed or manual updates, incompatible
     * replacements) always pass, exactly as before.
     */
    readonly admitDrain: (request: {
      readonly targetVersion: string;
      readonly automatic?: boolean | undefined;
    }) => Effect.Effect<boolean>;
  }
>()("goat/cloud/sshRuntimeAutoUpdate") {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeLaunchResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ status: Schema.String, pending: Schema.optionalKey(Schema.Unknown) }),
  ),
);

const lastLine = (stdout: string) =>
  stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line !== "") ?? "";

export const make = Effect.fn("server.ssh_runtime_auto_update.make")(function* (options?: {
  readonly ownVersion?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly pid?: number;
  /** Windows only. Tests supply this; production reads the registry and standard install paths. */
  readonly resolveGitBash?: () => Effect.Effect<string | undefined>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* SshRuntimeHost;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const ownVersion = options?.ownVersion ?? packageJson.version;
  const homeDir = options?.homeDir ?? NodeOS.homedir();
  const pid = options?.pid ?? process.pid;
  const platform = options?.platform ?? (yield* HostProcess.Platform);
  const defaultHome = NodePath.join(homeDir, ".goat");
  const stateDir = NodePath.join(defaultHome, "ssh-launch", REMOTE_RUNTIME_STATE_KEY);
  const versionsDir = NodePath.join(defaultHome, "runtime", "goat", "versions");
  // `/bin/sh` on POSIX. On Windows, Git for Windows bash, which is what OpenSSH already
  // uses to run these scripts. Undefined means this host stays client-driven.
  const shell =
    platform === "win32" ? yield* (options?.resolveGitBash ?? defaultWindowsGitBash)() : "/bin/sh";
  // Launch scripts only manage the server in the user's default home.
  const supported =
    config.mode !== "desktop" &&
    shell !== undefined &&
    NodePath.resolve(config.baseDir) === NodePath.resolve(defaultHome);
  const executableName = platform === "win32" ? "goat.exe" : "goat";
  const inFlight = yield* Ref.make(false);
  const pending = yield* Ref.make<string | undefined>(undefined);
  // The protocol each prepared target speaks, read from its own binary.
  const protocols = new Map<string, { readonly ssh: number; readonly orchestration: number }>();
  const fail = (reason: string) => new ServerSelfUpdateError({ reason });
  const { [SSH_REPLACEMENT_ID_ENV]: _replacementId, ...inherited } = process.env;
  // On Windows this is the native profile. Git Bash maps that HOME to a POSIX home as it
  // starts; converting it first would be rewritten a second time.
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: homeDir };
  const runner = (targetVersion: string): RemoteGoatRunnerOptions => ({
    archiveVersion: targetVersion,
    hostDownload: true,
    refreshOwnedRuntimeOnFirstConnection: true,
    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
  });

  const owned = Effect.gen(function* () {
    if (!supported) return false;
    const [pidFile, managed] = yield* Effect.all([
      host.readText(NodePath.join(stateDir, "pid")),
      host.readText(NodePath.join(stateDir, "managed")),
    ]);
    return pidFile?.trim() === String(pid) && managed?.trim() === "managed";
  });
  const failedTarget = host.readText(NodePath.join(stateDir, SSH_REPLACEMENT_RECORD_FILE)).pipe(
    Effect.map((text) => {
      const record = text === undefined ? undefined : readSshReplacementRecord(text);
      return record !== undefined && record.status !== "replaced"
        ? record.targetVersion
        : undefined;
    }),
  );
  // The executable must still be the one the verified install recorded.
  const verifiedExecutableSha256 = Effect.fn(
    "server.ssh_runtime_auto_update.verified_executable_sha256",
  )(function* (targetVersion: string) {
    const dir = NodePath.join(versionsDir, targetVersion);
    const [complete, record, actual] = yield* Effect.all([
      host.readText(NodePath.join(dir, ".install-complete")),
      host.readText(NodePath.join(dir, ".install-record")),
      host.sha256(NodePath.join(dir, executableName)),
    ]);
    const fields = record?.trim().split(" ") ?? [];
    if (
      complete?.trim() !== targetVersion ||
      fields[0] !== targetVersion ||
      actual === undefined ||
      fields[2] !== actual
    )
      return yield* fail(`goat@${targetVersion} has no verified install record.`);
    return actual;
  });

  const prepare = Effect.fn("server.ssh_runtime_auto_update.prepare")(function* (
    targetVersion: string,
  ) {
    if (shell === undefined)
      return yield* fail("This host has no Git Bash to update the SSH runtime.");
    // The host download trusts a completion marker, so an install whose executable no longer
    // matches a verified record is moved aside and downloaded again.
    const dir = NodePath.join(versionsDir, targetVersion);
    const unverified =
      (yield* host.readText(NodePath.join(dir, ".install-complete"))) !== undefined &&
      (yield* verifiedExecutableSha256(targetVersion).pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      ));
    const aside = unverified ? yield* host.moveAside(dir) : undefined;
    if (unverified && aside === undefined)
      return yield* fail(`Could not replace the unverified install of goat@${targetVersion}.`);
    // Verified against the release's SHA256SUMS exactly as a host download for a client is.
    const install = yield* host.run({
      command: shell,
      args: ["-s"],
      stdin: buildRemoteHostDownloadScript(runner(targetVersion)),
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.code !== 0 || lastLine(install.stdout) !== `goat v${targetVersion}`)
      return yield* fail(`Could not install goat@${targetVersion}.`);
    yield* verifiedExecutableSha256(targetVersion);
    if (aside !== undefined) yield* host.remove(aside);
    const preflight = yield* host.run({
      command: NodePath.join(versionsDir, targetVersion, executableName),
      args: [
        "__service-preflight",
        "--database-path",
        config.dbPath,
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ],
      env,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    const result =
      preflight.code === 0
        ? decodeServicePreflightResult(Option.getOrUndefined(decodeJson(preflight.stdout.trim())))
        : undefined;
    if (result === undefined || result.version !== targetVersion)
      return yield* fail(`goat@${targetVersion} failed its preflight.`);
    if (result.status === "blocked") return yield* fail(result.reason);
    const own = yield* host.run({
      command: NodePath.join(versionsDir, targetVersion, executableName),
      args: ["__ssh-helper", "protocol", "--shell"],
      env,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    const tokens = /^(\S+) (\d+) (\d+) \d+ \d+$/u.exec(lastLine(own.stdout));
    if (own.code !== 0 || tokens?.[1] !== targetVersion)
      return yield* fail(`goat@${targetVersion} did not report its protocol.`);
    const protocol = { ssh: Number(tokens[2]), orchestration: Number(tokens[3]) };
    // Only a target this runtime already serves keeps the idle-only refresh path, and lets the
    // target's supervisor accept this version again on rollback. A protocol change stays with
    // the clients, which replace an incompatible runtime themselves.
    if (
      compareRuntimeProtocols(
        {
          ssh: { min: protocol.ssh, max: protocol.ssh },
          orchestration: { min: protocol.orchestration, max: protocol.orchestration },
        },
        { protocol: servedRuntimeProtocolRanges() },
      ) !== "compatible"
    )
      return yield* fail(
        `goat@${targetVersion} speaks a protocol this runtime does not serve; a client on that release replaces it.`,
      );
    protocols.set(targetVersion, protocol);
    yield* Ref.set(pending, targetVersion);
  });

  const idle = Effect.gen(function* () {
    const activity = yield* projections
      .getServerActivity()
      .pipe(Effect.orElseSucceed(() => "busy" as const));
    return (yield* admission.inFlight) === 0 && activity === "idle";
  });

  const activate = (targetVersion: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(inFlight, true)) return "busy" as const;
        return yield* restore(
          Effect.gen(function* () {
            if (!(yield* owned)) return yield* fail("This server no longer owns the SSH runtime.");
            // First idle check; the launch script checks again under the host replacement lock,
            // and its drain closes admission before a third wait for idle.
            if (!(yield* idle)) return "busy" as const;
            const liveRunnerSha256 = yield* host.sha256(NodePath.join(stateDir, "run-t3.sh"));
            if (liveRunnerSha256 === undefined)
              return yield* fail("The SSH runtime's run-t3.sh is missing.");
            const installedExecutableSha256 = yield* verifiedExecutableSha256(targetVersion);
            const candidateProtocol = protocols.get(targetVersion);
            if (candidateProtocol === undefined)
              return yield* fail(`goat@${targetVersion} was not prepared.`);
            // The script is written on the target's behalf, so it checks the target's protocol.
            const options = { ...runner(targetVersion), candidateProtocol };
            const selection: PreparedRemoteRuntime = {
              runner: options,
              version: targetVersion,
              requestedVersion: targetVersion,
              source: "requested",
              requireInstalled: true,
              retainedRunnerSha256: null,
              mayUpgradeOwnedServer: true,
              refreshIfIdle: true,
              expectedLiveVersion: ownVersion,
              expectedLiveRunnerSha256: liveRunnerSha256,
              installedExecutableSha256,
            };
            if (shell === undefined)
              return yield* fail("This host has no Git Bash to update the SSH runtime.");
            const result = yield* host.runDetached({
              shell,
              script: buildRemoteLaunchScript(options, selection),
              args: [REMOTE_RUNTIME_STATE_KEY],
              env,
              cwd: homeDir,
            });
            const launched = Option.getOrUndefined(decodeLaunchResult(lastLine(result.stdout)));
            const status = launched?.status;
            // "ready" with a pending replacement means the script kept this server attached.
            if (status === "pending" || launched?.pending !== undefined) return "busy" as const;
            if (result.code === 0 && status === "ready") return "requested" as const;
            return yield* fail(
              `The SSH runtime replacement for goat@${targetVersion} failed (exit ${result.code ?? "signal"}).`,
            );
          }),
        ).pipe(Effect.ensuring(Ref.set(inFlight, false)));
      }),
    );

  const admitDrain = Effect.fn("server.ssh_runtime_auto_update.admit_drain")(function* (request: {
    readonly targetVersion: string;
    readonly automatic?: boolean | undefined;
  }) {
    if (request.automatic !== true || automaticUpdateChannel(ownVersion) === undefined) return true;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.automaticServerUpdates),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) {
      yield* Effect.logInfo("server.auto_update.request-dropped", {
        targetVersion: request.targetVersion,
        reason: "disabled",
      });
      return false;
    }
    const own = yield* Ref.get(pending);
    const chosen = arbitrateAutomaticTargets({
      ownVersion,
      failedTarget: yield* failedTarget,
      candidates: own === undefined ? [request.targetVersion] : [request.targetVersion, own],
    });
    if (chosen === request.targetVersion) return true;
    yield* Effect.logInfo("server.auto_update.request-dropped", {
      targetVersion: request.targetVersion,
      chosen,
    });
    return false;
  });

  return SshRuntimeAutoUpdate.of({
    supported,
    owned,
    isUpdating: Ref.get(inFlight),
    failedTarget,
    prepare,
    activate,
    clearPending: Ref.set(pending, undefined),
    admitDrain,
  });
});

export const layer = Layer.effect(SshRuntimeAutoUpdate, make()).pipe(Layer.provide(layerHost));

export const layerArbiter = Layer.effect(
  RuntimeDrain.RuntimeUpdateArbiter,
  Effect.map(SshRuntimeAutoUpdate, (runtime) => ({ admit: runtime.admitDrain })),
);
