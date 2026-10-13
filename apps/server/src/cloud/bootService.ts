import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as Schema from "effect/Schema";

import { CLI_RELEASE_BASE_URL_ENV } from "@goat/shared/cliRelease";
import {
  LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
  LEGACY_BOOT_SERVICE_UNIT_FILE,
  legacyEnvName,
} from "@goat/contracts/legacyT3Names";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  compareExactServiceVersions,
  parseServiceState,
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";

/** The names a service manager knows one install by. */
export interface BootServiceNames {
  readonly unitFile: string;
  readonly launchdLabel: string;
}

export const BOOT_SERVICE_NAMES: BootServiceNames = {
  unitFile: "goat.service",
  // Distinct from the desktop app's bundle id (si.goat.desktop), so launchd
  // and TCC records never collide.
  launchdLabel: "si.goat.service",
};

/**
 * Installed by builds before the GOAT rename, and by upstream T3 Code. Install
 * and restart move a legacy unit that serves this GOAT home to the current
 * names; a legacy unit serving another home belongs to someone else.
 */
export const LEGACY_BOOT_SERVICE_NAMES: BootServiceNames = {
  unitFile: LEGACY_BOOT_SERVICE_UNIT_FILE,
  launchdLabel: LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
};

const plistFileOf = (names: BootServiceNames) => `${names.launchdLabel}.plist`;
const BOOT_SERVICE_UNIT_ENV = "GOAT_BOOT_SERVICE_UNIT";
const BOOT_SERVICE_HOME_ENV = "GOAT_HOME";
/**
 * Units carry both spellings: the launcher may start a retained server version built
 * before the GOAT rename, and units installed by those builds name only the legacy one.
 */
const bootServiceEnvNames = (name: string) => [name, legacyEnvName(name) ?? name] as const;
/** File in the logs dir that receives the service's stdout and stderr. `goat triage` points agents at it. */
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/**
 * Reads `GOAT_HOME` back out of a rendered unit or plist. Only values this
 * file writes are expected, so a quoted systemd value is unquoted and
 * unescaped the same way `quoteSystemdValue` produced it.
 */
export function bootServiceBaseDirOf(contents: string): string | undefined {
  const homeNames = bootServiceEnvNames(BOOT_SERVICE_HOME_ENV).join("|");
  const systemd = new RegExp(`^Environment=(?:${homeNames})=(.*)$`, "m").exec(contents)?.[1];
  if (systemd !== undefined) {
    const raw = systemd.trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
        : raw;
    return unquoted.replaceAll("%%", "%");
  }
  const plist = new RegExp(`<key>(?:${homeNames})</key>\\s*<string>([^<]*)</string>`).exec(
    contents,
  )?.[1];
  if (plist !== undefined) {
    return plist.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  return undefined;
}

export interface BootServicePlan {
  /**
   * What the service manager executes. npm-distributed runtimes run the
   * standalone launcher script with the installing Node; archive-distributed
   * runtimes run their own executable, which hosts the launcher as a hidden
   * subcommand so the machine never needs Node.
   */
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(
  plan: BootServicePlan,
  names: BootServiceNames = BOOT_SERVICE_NAMES,
): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=GOAT server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    ...bootServiceEnvNames(BOOT_SERVICE_HOME_ENV).map(
      (name) => `Environment=${name}=${quoteSystemdValue(plan.baseDir)}`,
    ),
    ...bootServiceEnvNames(BOOT_SERVICE_UNIT_ENV).map(
      (name) => `Environment=${name}=${names.unitFile}`,
    ),
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agents and terminals run in their own scopes in app-goat-agents.slice
    // (see process/agentScope.ts). Short helper commands still share this
    // cgroup, and with the systemd default of OOMPolicy=stop, the kernel
    // killing one of them stops the whole unit. Keep running and let
    // Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    // The agents slice is a sibling in app.slice, so these weights keep the
    // server responsive while agents saturate CPU or disk.
    "CPUWeight=1000",
    "IOWeight=1000",
    // systemd-oomd only honors this when the cgroup it watches is owned by the
    // same user. Distros watch user-1000.slice, which root owns, so there it is
    // ignored. The agent scopes are what keep oomd off the server.
    "ManagedOOMPreference=avoid",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Plist values are emitted as XML text nodes; only these three need escaping. */
function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: {
    readonly homeDir: string;
    readonly environmentPath: string;
    readonly names?: BootServiceNames;
  },
): string {
  const names = options.names ?? BOOT_SERVICE_NAMES;
  // KeepAlive + ThrottleInterval mirror Restart=always + RestartSec=5. launchd
  // has no StartLimitBurst analog; a hard crash loop respawns every 5s forever.
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${names.launchdLabel}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    ...bootServiceEnvNames(BOOT_SERVICE_HOME_ENV).flatMap((name) => [
      `    <key>${name}</key>`,
      `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    ]),
    ...bootServiceEnvNames(BOOT_SERVICE_UNIT_ENV).flatMap((name) => [
      `    <key>${name}</key>`,
      `    <string>${plistFileOf(names)}</string>`,
    ]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites an installed legacy unit or plist to the current names and keeps
 * everything else, including the runtime version it starts. `restart` uses
 * this because it must not switch versions while it moves the unit.
 */
export function migrateLegacyBootServiceUnit(contents: string): string {
  const legacy = LEGACY_BOOT_SERVICE_NAMES;
  const current = BOOT_SERVICE_NAMES;
  return contents
    .replace(/^Description=T3 Code server$/m, "Description=GOAT server")
    .replace(
      new RegExp(`^(Environment=[A-Z0-9_]+=)${escapeRegExp(legacy.unitFile)}$`, "gm"),
      `$1${current.unitFile}`,
    )
    .replace(
      new RegExp(`<string>${escapeRegExp(legacy.launchdLabel)}(\\.plist)?</string>`, "g"),
      `<string>${current.launchdLabel}$1</string>`,
    );
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored. Reserved for steps whose common
   * failures (not loaded, already enabled) leave a state a later strict step
   * either tolerates or fails loudly on.
   */
  readonly optional?: boolean;
  /** Override the ProcessRunner default (60s) for steps that block longer. */
  readonly timeout?: Duration.Input;
}

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
const STOP_STEP_TIMEOUT = Duration.seconds(120);

/**
 * Platform service-manager integration as data: paths, a pure renderer, and
 * the command steps each flow runs. install/uninstall/status consume this and
 * never branch on platform.
 */
export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  /** Before rewriting files, when a unit is already installed. */
  readonly stop: ReadonlyArray<BootServiceStep>;
  /** After files are written. The last entry starts the service. */
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** Best-effort recovery after a failed repair of an installed service. */
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Uninstall, before the unit file is removed. */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Uninstall, after the unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}

interface OwnedLegacyUnit {
  readonly manager: BootServiceManager;
  readonly contents: string;
}

function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly names: BootServiceNames;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    ".config",
    "systemd",
    "user",
    input.names.unitFile,
  );
  return {
    kind: "systemd",
    unitPath,
    render: (plan) => renderBootServiceUnit(plan, input.names),
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", input.names.unitFile],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        step: "enabling the service",
        command: "systemctl",
        args: ["--user", "enable", input.names.unitFile],
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", input.names.unitFile],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", input.names.unitFile],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", input.names.unitFile],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}

function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly names: BootServiceNames;
  readonly uid: number;
  readonly environmentPath: string;
}): BootServiceManager {
  const unitPath = input.path.join(
    input.homeDir,
    "Library",
    "LaunchAgents",
    plistFileOf(input.names),
  );
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${input.names.launchdLabel}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate
  // kickstart would kill and restart a server it just booted. A lingering job
  // that survived bootout, or a gui domain with nobody logged in at the
  // screen (SSH install), makes bootstrap fail the flow loudly rather than
  // silently keeping a stale server.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
        names: input.names,
      }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a
    // later reinstall. Removing the plist is what stops the next login load.
    // A bootout that fails for a reason other than "not loaded" leaves the
    // job running until logout; the failure is in the boot-service log.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}

/** Undefined means this host cannot run the background service. */
function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly names: BootServiceNames;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }
  if (input.platform === "linux") {
    return systemdManager({ path: input.path, homeDir: input.homeDir, names: input.names });
  }
  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
      names: input.names,
    });
  }
  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedError<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedError<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedError<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the GOAT background service.";
  }
}

const BootServiceProblem = Schema.Literals([
  "user-manager-unavailable",
  "linger-unavailable",
  "linger-disabled",
  "service-disabled",
  "service-stopped",
  "restart-pending",
]);
type BootServiceProblem = typeof BootServiceProblem.Type;

/** These codes and recovery steps are documented in docs/user/background-service.md. */
export function formatBootServiceProblem(problem: BootServiceProblem): string {
  switch (problem) {
    case "user-manager-unavailable":
      return "Cannot reach the systemd user manager. Run `systemctl --user status` in a login session for the service user. Install your distribution's systemd user-session support if it is missing; do not run GOAT with sudo.";
    case "linger-unavailable":
      return 'Cannot check whether this user can run services after logout. Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.';
    case "linger-disabled":
      return 'Lingering is disabled. GOAT will stop when your last login session ends and will not start at boot. Run `sudo loginctl enable-linger "$(id -un)"` on this machine, then retry the service command as your normal user.';
    case "service-disabled":
      return "The service is not enabled to start automatically. Run `goat service install` to repair it.";
    case "service-stopped":
      return "The service is not running. Check the service log and `systemctl --user status goat.service`, then run `goat service install`.";
    case "restart-pending":
      return "A newer version is installed but the service is still running the previous one. Run `goat service restart` to switch.";
  }
}

export class BootServicePrerequisiteError extends Schema.TaggedError<BootServicePrerequisiteError>()(
  "BootServicePrerequisiteError",
  { problem: BootServiceProblem, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `[${this.problem}] ${formatBootServiceProblem(this.problem)}`;
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedError<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export class BootServiceDowngradeRefusedError extends Schema.TaggedError<BootServiceDowngradeRefusedError>()(
  "BootServiceDowngradeRefusedError",
  {
    installedVersion: Schema.String,
    targetVersion: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to replace goat@${this.installedVersion} with older goat@${this.targetVersion}. Run the command again with --allow-downgrade to continue.`;
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServicePrerequisiteError
  | BootServiceUpdatePendingError
  | BootServiceDowngradeRefusedError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly installedVersion?: string;
  /**
   * The GOAT home the installed unit serves. The unit name is fixed per user,
   * so a caller working against another base dir must not treat this service
   * as its own; `goat update --base-dir` learned that by restarting the live
   * server of the machine it ran on.
   */
  readonly installedBaseDir?: string;
  readonly problems?: ReadonlyArray<BootServiceProblem>;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (options?: {
      readonly allowDowngrade?: boolean;
      /**
       * Write the unit for this version but leave the service on whatever it
       * is running now. `goat update` uses this when the user declines the
       * restart, so a later `goat service restart` lands on the new version.
       */
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Stop and start the installed service on the version its unit names.
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone. Resolves false when nothing was
     * restarted.
     */
    readonly restart: Effect.Effect<boolean, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("goat/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const uid = yield* HostProcess.UserId;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };
  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );
  const environmentPath = Array.from(
    new Set([
      ...xmlSafeInstallerDirectories,
      path.dirname(host.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ).join(":");

  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
    names: BOOT_SERVICE_NAMES,
  });
  const legacyManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
    names: LEGACY_BOOT_SERVICE_NAMES,
  });
  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, BOOT_SERVICE_LOG_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const restartPendingPath = path.join(input.baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion, platform);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        // Opened read-write: Windows refuses to flush a handle without write access.
        yield* (yield* fs.open(tempPath, { flag: "r+" })).sync;
        yield* fs.rename(tempPath, filePath);
        // Windows has no directory fsync (EPERM); NTFS journals the rename.
        yield* (yield* fs.open(directory, { flag: "r" })).sync.pipe(
          Effect.catchIf(
            (error) => (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM",
            () => Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  // The executable hosts the launcher as a hidden subcommand of itself, so
  // the unit runs the pinned runtime directly.
  const plan: BootServicePlan = {
    program: [runtimePaths.entryPath, "__service-launcher"],
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const logFailure = (error: { readonly message: string }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError(logFailure),
    );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(
          entry.step,
          entry.command,
          entry.args,
          entry.timeout === undefined ? undefined : { timeout: entry.timeout },
        );
        // runStep's tapError already appends the failure to the log, so an
        // ignored optional step still leaves a trace.
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  const probe = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.seconds(5) }).pipe(Effect.option);
  const succeeded = (result: Option.Option<ProcessRunner.ProcessRunOutput>) =>
    Option.isSome(result) && result.value.code === 0;
  const lingerArgs = [
    "show-user",
    ...(uid === undefined ? [] : [String(uid)]),
    "--property=Linger",
    "--value",
  ];
  const readSystemdProblems = Effect.fn("cloud.boot_service.read_systemd_problems")(function* (
    includeService: boolean,
    serviceUnitFile: string = BOOT_SERVICE_NAMES.unitFile,
  ) {
    const [manager, linger] = yield* Effect.all(
      [probe("systemctl", ["--user", "show-environment"]), probe("loginctl", lingerArgs)],
      { concurrency: "unbounded" },
    );
    const problems: BootServiceProblem[] = [];
    if (!succeeded(manager)) problems.push("user-manager-unavailable");
    const lingering = succeeded(linger) && Option.isSome(linger) ? linger.value.stdout.trim() : "";
    if (lingering !== "yes") {
      problems.push(lingering === "no" ? "linger-disabled" : "linger-unavailable");
    }
    if (includeService && succeeded(manager)) {
      const [enabled, active] = yield* Effect.all(
        [
          probe("systemctl", ["--user", "is-enabled", serviceUnitFile]),
          probe("systemctl", ["--user", "is-active", serviceUnitFile]),
        ],
        { concurrency: "unbounded" },
      );
      if (
        !succeeded(enabled) ||
        (Option.isSome(enabled) && enabled.value.stdout.trim() !== "enabled")
      ) {
        problems.push("service-disabled");
      }
      if (!succeeded(active)) problems.push("service-stopped");
    }
    return problems;
  });

  const requireSystemdPrerequisites = Effect.gen(function* () {
    const problems = yield* readSystemdProblems(false);
    const unavailable = problems.find((problem) => problem !== "linger-disabled");
    if (unavailable) return yield* new BootServicePrerequisiteError({ problem: unavailable });
    if (!problems.includes("linger-disabled")) return;
    yield* runStep("enabling lingering for this user", "loginctl", [
      "enable-linger",
      "--no-ask-password",
      ...(uid === undefined ? [] : [String(uid)]),
    ]).pipe(
      Effect.mapError(
        (cause) => new BootServicePrerequisiteError({ problem: "linger-disabled", cause }),
      ),
    );
    const remaining = yield* readSystemdProblems(false);
    if (remaining[0]) return yield* new BootServicePrerequisiteError({ problem: remaining[0] });
  });

  /**
   * A unit installed under the legacy names that serves this GOAT home. One
   * that serves another home is upstream T3 Code's or another install's, and
   * is never touched.
   */
  const readOwnedLegacyUnit = Effect.gen(function* () {
    if (legacyManager === undefined) return Option.none<OwnedLegacyUnit>();
    const contents = yield* fs.readFileString(legacyManager.unitPath).pipe(Effect.option);
    if (Option.isNone(contents)) return Option.none<OwnedLegacyUnit>();
    const servedBaseDir = bootServiceBaseDirOf(contents.value);
    return servedBaseDir !== undefined &&
      path.resolve(servedBaseDir) === path.resolve(input.baseDir)
      ? Option.some<OwnedLegacyUnit>({ manager: legacyManager, contents: contents.value })
      : Option.none<OwnedLegacyUnit>();
  });

  /** Disables the legacy unit and removes its file. Callers stop it first. */
  const retireLegacyUnit = (legacy: OwnedLegacyUnit) =>
    runSteps(legacy.manager.deactivate).pipe(
      Effect.andThen(
        fs
          .remove(legacy.manager.unitPath, { force: true })
          .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))),
      ),
    );

  /**
   * Rollback for a migration that failed: drop the new unit, put the legacy
   * file back as it was, and start it again. Best effort, like `restart`.
   */
  const reinstateLegacyUnit = (manager: BootServiceManager, legacy: OwnedLegacyUnit) =>
    Effect.gen(function* () {
      yield* runSteps(manager.deactivate).pipe(Effect.ignore);
      yield* fs.remove(manager.unitPath, { force: true }).pipe(Effect.ignore);
      yield* writeDurably(legacy.manager.unitPath, legacy.contents);
      yield* runSteps(legacy.manager.activate);
    }).pipe(Effect.ignore);

  const install = Effect.fn("cloud.boot_service.install")(function* (options?: {
    readonly allowDowngrade?: boolean;
    readonly start?: boolean;
  }) {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // A permissions failure must not leave a partial install or stop a working server.
    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            args: [...pinnedRuntimeCommand(runtime).args, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned goat runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned goat runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError"
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );
    const currentInstalled = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    const legacy = yield* readOwnedLegacyUnit;
    const installed = currentInstalled || Option.isSome(legacy);
    // With start=false the service keeps running while its files change. The
    // launcher reads the state file once at startup and the unit only matters
    // on the next start, so that is safe as long as the launcher is not in
    // the middle of a remote update, which is the one time it writes the
    // state file itself. That case is refused below, before anything is
    // written, from the same read the downgrade check uses; the stop that
    // normally serialises against the launcher is skipped on purpose.
    const start = options?.start !== false;
    // Without a start the legacy service keeps running, so its unit is
    // updated in place: a second unit under the new name would start a second
    // server at the next boot. The next restart or started install moves it.
    const target =
      !start && !currentInstalled && Option.isSome(legacy) ? legacy.value.manager : manager;
    if (installed && start) {
      if (currentInstalled) yield* runSteps(manager.stop);
      if (Option.isSome(legacy)) yield* runSteps(legacy.value.manager.stop);
    }

    yield* Effect.gen(function* () {
      if (installed) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);
        if (Option.isSome(previousStateText)) {
          if (serviceStateHasPendingUpdate(previousStateText.value)) {
            return yield* new BootServiceUpdatePendingError();
          }
          // A remote update can finish after the CLI checks status. Read its
          // final version after the launcher stops and before changing files.
          const installedVersion = serviceStateActiveVersion(previousStateText.value);
          if (
            installedVersion !== undefined &&
            options?.allowDowngrade !== true &&
            compareExactServiceVersions(input.cliVersion, installedVersion) < 0
          ) {
            return yield* new BootServiceDowngradeRefusedError({
              installedVersion,
              targetVersion: input.cliVersion,
            });
          }
        }
      }
      yield* fs
        .makeDirectory(path.dirname(target.unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      if (!start && installed) {
        // Written first: once the files below name the new version, the
        // running service is behind them, and a failure between the two
        // writes must not leave it looking current. The launcher removes the
        // marker when it starts, `restart` and a started install do too.
        yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
      }
      yield* writeDurably(
        statePath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
        `${JSON.stringify(
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: input.cliVersion,
          } satisfies ServiceState,
          null,
          2,
        )}\n`,
      );
      if (!start && installed) {
        // The launcher only writes this file while a remote update is in
        // flight. One that began after the check above lands either before
        // this write (then the launcher's copy in memory is what it keeps
        // acting on, and its next write puts its own outcome back) or after
        // it, which this read catches: the file no longer says what was just
        // written, so stop here before repointing the unit.
        const written = yield* fs.readFileString(statePath);
        if (serviceStateActiveVersion(written) !== input.cliVersion) {
          return yield* new BootServiceUpdatePendingError();
        }
      }
      yield* writeDurably(target.unitPath, target.render(plan));

      if (start) {
        if (Option.isSome(legacy)) yield* retireLegacyUnit(legacy.value);
        yield* runSteps(manager.activate);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      Effect.tapError(() => {
        if (!start) return Effect.void;
        if (currentInstalled) return runSteps(manager.restart).pipe(Effect.ignore);
        if (Option.isSome(legacy)) return reinstateLegacyUnit(manager, legacy.value);
        return Effect.void;
      }),
    );
    return plan;
  });

  const restart: BootService["Service"]["restart"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const legacy = yield* readOwnedLegacyUnit;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) {
      if (Option.isNone(legacy)) return false;
      // Move the legacy unit to the new names without changing the version it starts.
      yield* runSteps(legacy.value.manager.stop);
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
        yield* writeDurably(unitPath, migrateLegacyBootServiceUnit(legacy.value.contents));
        yield* retireLegacyUnit(legacy.value);
        yield* runSteps(manager.activate);
      }).pipe(Effect.tapError(() => reinstateLegacyUnit(manager, legacy.value)));
      yield* fs.remove(restartPendingPath, { force: true });
      return true;
    }
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (
      installedBaseDir === undefined ||
      path.resolve(installedBaseDir) !== path.resolve(input.baseDir)
    ) {
      return false;
    }
    yield* runSteps(manager.stop);
    // A legacy unit left behind next to the current one would start a second server at boot.
    const retireLeftover = Option.isSome(legacy)
      ? runSteps(legacy.value.manager.stop).pipe(Effect.andThen(retireLegacyUnit(legacy.value)))
      : Effect.void;
    yield* retireLeftover.pipe(
      Effect.andThen(runSteps(manager.activate)),
      // Same recovery as a failed repair: a service that was running should
      // not be left stopped because daemon-reload or enable failed.
      Effect.tapError(() => runSteps(manager.restart).pipe(Effect.ignore)),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return true;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const currentInstalled = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    const legacy = yield* readOwnedLegacyUnit;
    if (!currentInstalled && Option.isNone(legacy)) return false;
    if (currentInstalled) {
      yield* runSteps(manager.deactivate);
      yield* fs
        .remove(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    }
    if (Option.isSome(legacy)) yield* retireLegacyUnit(legacy.value);
    yield* runSteps(manager.finalize);
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }
    if (!(yield* fs.exists(unitPath))) {
      const legacy = yield* readOwnedLegacyUnit;
      if (Option.isNone(legacy)) {
        return { supported: true, installed: false, current: false, unitPath, logPath };
      }
      // Installed under the legacy names: never current, so `goat service install` moves it.
      const stateText = yield* fs.readFileString(statePath).pipe(Effect.option);
      const installedVersion = Option.isSome(stateText)
        ? serviceStateActiveVersion(stateText.value)
        : undefined;
      const problems: BootServiceProblem[] =
        detectedManager.kind === "systemd"
          ? [...(yield* readSystemdProblems(true, LEGACY_BOOT_SERVICE_NAMES.unitFile))]
          : [];
      return {
        supported: true,
        installed: true,
        current: false,
        ...(installedVersion === undefined ? {} : { installedVersion }),
        installedBaseDir: input.baseDir,
        problems,
        unitPath: legacy.value.manager.unitPath,
        logPath,
      };
    }
    const [unit, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
      fs.readFileString(unitPath),
      fs.exists(runtimePaths.entryPath),
      fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
      fs.readFileString(statePath).pipe(Effect.option),
    ]);
    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
    const installedVersion = Option.isSome(stateText)
      ? serviceStateActiveVersion(stateText.value)
      : undefined;
    const installedBaseDir = bootServiceBaseDirOf(unit);
    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;
    const problems: BootServiceProblem[] =
      detectedManager.kind === "systemd" ? [...(yield* readSystemdProblems(true))] : [];
    if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
    return {
      supported: true,
      installed: true,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
      problems,
      current:
        problems.length === 0 &&
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, restart, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
