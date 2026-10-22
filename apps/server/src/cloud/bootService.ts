import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  GOAT_ENVIRONMENT_PATH,
  LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
  LEGACY_BOOT_SERVICE_UNIT_FILE,
  legacyEnvName,
} from "@goat/contracts/legacyT3Names";
import { CLI_RELEASE_BASE_URL_ENV } from "@goat/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  PinnedRuntimeInstallError,
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
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

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export function bootServiceBaseDirOf(contents: string): string | undefined {
  const homeNames = bootServiceEnvNames(BOOT_SERVICE_HOME_ENV).join("|");
  const systemd = new RegExp(`^Environment=(?:${homeNames})=(.*)$`, "m").exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = new RegExp(`<key>(?:${homeNames})</key>\\s*<string>([^<]*)</string>`).exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

/** The executable an installed unit or plist starts: the launcher's runtime. */
export function bootServiceProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

export interface BootServicePlan {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  /** The manager accepted a detached install; its outcome is written to `logPath`. */
  readonly handedOff?: boolean;
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
    // killing one of them stops the whole unit.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    // The agents slice is a sibling in app.slice, so these weights keep the
    // server responsive while agents saturate CPU or disk.
    "CPUWeight=1000",
    "IOWeight=1000",
    // systemd-oomd only honors this when the cgroup it watches is owned by the
    // same user. Distros watch user-1000.slice, which root owns, so there it is
    // ignored.
    "ManagedOOMPreference=avoid",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

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
   * Non-zero exit is logged and ignored.
   */
  readonly optional?: boolean;
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
 * `systemctl restart` and `launchctl bootstrap` return when the unit is loaded,
 * which is before the server is listening — and a pinned runtime that exits
 * immediately still counts as a successful start. Success waits until this
 * home's service-managed server answers, or the unit is already dead.
 */
const SERVICE_READY_TIMEOUT = Duration.seconds(60);
const SERVICE_READY_POLL = Duration.millis(200);
/** The environment descriptor field that identifies which server answered. */
const ServiceEnvironmentAnswer = Schema.Struct({
  serverVersion: Schema.optionalKey(Schema.String),
});

export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  readonly stop: ReadonlyArray<BootServiceStep>;
  readonly activate: ReadonlyArray<BootServiceStep>;
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Queue a restart owned by the manager, since stopping would kill the caller. */
  readonly handoff?: ReadonlyArray<BootServiceStep>;
  readonly deactivate: ReadonlyArray<BootServiceStep>;
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
  const prepareActivation = [
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
  ];
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
      ...prepareActivation,
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
    handoff: [
      ...prepareActivation,
      {
        step: "restarting the service",
        command: "systemctl",
        args: ["--user", "restart", "--no-block", input.names.unitFile],
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
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate kickstart
  // would kill and restart a server it just booted.
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
    // No `launchctl disable` here: a persisted override would sabotage a later
    // reinstall.
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
      readonly start?: boolean;
    }) => Effect.Effect<BootServicePlan, BootServiceError>;
    /**
     * Only when the unit serves this base dir: the unit name is per user, so
     * another home's service is left alone, which resolves `skipped`. From
     * inside the service the restart can only be `queued` with the service
     * manager, since the stop ends this process.
     */
    readonly restart: Effect.Effect<"restarted" | "queued" | "skipped", BootServiceError>;
    /**
     * Run `operation` while this home's installed service is stopped, then
     * start it again when it was enabled (systemd) or loaded (launchd)
     * beforehand. A service that belongs to another home is left alone. The
     * service is started again even when stopping it failed; the operation's
     * own failure is reported ahead of a failure to restart.
     */
    readonly withStopped: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | BootServiceError, R>;
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
  const inheritedServiceUnit = yield* Config.String(BOOT_SERVICE_UNIT_ENV).pipe(
    Config.withDefault(""),
  );
  const runningInsideService = [
    BOOT_SERVICE_NAMES.unitFile,
    LEGACY_BOOT_SERVICE_NAMES.unitFile,
  ].includes(inheritedServiceUnit);
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
  const servesThisHome = (baseDir: string | undefined) =>
    baseDir !== undefined && path.resolve(baseDir) === path.resolve(input.baseDir);

  const readOwnedLegacyUnit = Effect.gen(function* () {
    if (legacyManager === undefined) return Option.none<OwnedLegacyUnit>();
    const contents = yield* fs.readFileString(legacyManager.unitPath).pipe(Effect.option);
    if (Option.isNone(contents)) return Option.none<OwnedLegacyUnit>();
    const servedBaseDir = bootServiceBaseDirOf(contents.value);
    return servesThisHome(servedBaseDir)
      ? Option.some<OwnedLegacyUnit>({ manager: legacyManager, contents: contents.value })
      : Option.none<OwnedLegacyUnit>();
  });

  /**
   * `goat.service` is one unit per user. A file that serves another home belongs
   * to that home; this command must not stop, replace, or report it as ours.
   */
  const readCurrentUnit = Effect.gen(function* () {
    const contents = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(contents)) return { _tag: "Absent" as const };
    const servedBaseDir = bootServiceBaseDirOf(contents.value);
    return servesThisHome(servedBaseDir)
      ? { _tag: "Owned" as const, contents: contents.value }
      : { _tag: "Foreign" as const, baseDir: servedBaseDir };
  });

  const runtimeStatePath = path.join(input.baseDir, "userdata", "server-runtime.json");

  const serviceLiveness = (manager: BootServiceManager) =>
    Effect.gen(function* () {
      if (manager.kind === "systemd") {
        const active = yield* probe("systemctl", [
          "--user",
          "is-active",
          path.basename(manager.unitPath),
        ]);
        return succeeded(active) ? "running" : "dead";
      }
      const printed = yield* probe("launchctl", [
        "print",
        `gui/${uid}/${path.basename(manager.unitPath, ".plist")}`,
      ]);
      if (!succeeded(printed) || Option.isNone(printed)) return "dead";
      const stdout = printed.value.stdout;
      if (/^\s*pid = [1-9]\d*/m.test(stdout)) return "running";
      const lastExit = /last exit code = (\d+)/.exec(stdout);
      if (lastExit !== null && lastExit[1] !== "0") return "dead";
      // Loaded, not started yet. RunAtLoad can lag a GUI login; an SSH
      // Background session may stay here until the next login.
      return "pending";
    });

  /** Resolves once the new unit's server answers the environment descriptor. */
  const awaitServiceAnswer = (manager: BootServiceManager, begunAt: number) =>
    Effect.gen(function* () {
      const deadline = begunAt + Duration.toMillis(SERVICE_READY_TIMEOUT);
      const giveUp = new BootServiceCommandError({ step: "waiting for the service to answer" });
      while ((yield* Clock.currentTimeMillis) <= deadline) {
        const runtime = yield* readPersistedServerRuntimeState(runtimeStatePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        if (
          Option.isSome(runtime) &&
          runtime.value.serviceManaged === true &&
          runtime.value.serverVersion === input.cliVersion &&
          Date.parse(runtime.value.startedAt) >= begunAt
        ) {
          const requestUrl = yield* Effect.try({
            try: () => new URL(GOAT_ENVIRONMENT_PATH, runtime.value.origin).href,
            catch: () => "bad-origin" as const,
          }).pipe(Effect.option);
          if (Option.isSome(requestUrl)) {
            const reported = yield* httpClient
              .execute(HttpClientRequest.get(requestUrl.value))
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ServiceEnvironmentAnswer)),
                Effect.timeout(Duration.seconds(1)),
                Effect.option,
              );
            if (Option.isSome(reported) && reported.value.serverVersion === input.cliVersion) {
              return;
            }
          }
        }
        if ((yield* serviceLiveness(manager)) === "dead") return yield* giveUp;
        yield* Effect.sleep(SERVICE_READY_POLL);
      }
      return yield* giveUp;
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
   * file back as it was, and start it again. `restore` runs first so the
   * legacy launcher does not read the new activeVersion. Best effort, like
   * `restart`.
   */
  const reinstateLegacyUnit = (
    manager: BootServiceManager,
    legacy: OwnedLegacyUnit,
    restore: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.gen(function* () {
      yield* restore;
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
    const current = yield* readCurrentUnit;
    if (current._tag === "Foreign") {
      return yield* new BootServiceCommandError({
        step: `the service for this user belongs to ${current.baseDir ?? "another GOAT home"}`,
      });
    }
    const currentInstalled = current._tag === "Owned";
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    if (manager.kind === "systemd") {
      yield* requireSystemdPrerequisites.pipe(Effect.tapError(logFailure));
    }

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
    const legacy = yield* readOwnedLegacyUnit;
    const installed = currentInstalled || Option.isSome(legacy);
    // With start=false the service keeps running while its files change. The
    // launcher reads the state file once at startup and the unit only matters
    // on the next start, so that is safe as long as the launcher is not in the
    // middle of a remote update, which is the one time it writes the state file
    // itself.
    const start = options?.start !== false;
    // Without a start the legacy service keeps running, so its unit is
    // updated in place: a second unit under the new name would start a second
    // server at the next boot. The next restart or started install moves it.
    const target =
      !start && !currentInstalled && Option.isSome(legacy) ? legacy.value.manager : manager;
    if (installed && start && runningInsideService && manager.kind === "systemd") {
      // Stopping the unit from inside it kills this process before the start.
      // A transient unit runs the same install from outside, stop first, so it
      // still serialises with a remote update the launcher may be starting.
      yield* runStep("handing the install to a transient unit", "systemd-run", [
        "--user",
        "--collect",
        "--quiet",
        // Transient properties reach systemd literally, unlike unit-file specifiers.
        `--property=StandardOutput=append:${logPath}`,
        `--property=StandardError=append:${logPath}`,
        `--setenv=${BOOT_SERVICE_UNIT_ENV}=`,
        runtimePaths.entryPath,
        "service",
        "install",
        "--base-dir",
        // systemd expands $VAR in arguments (not in the executable path).
        input.baseDir.replaceAll("$", () => "$$"),
        ...(options?.allowDowngrade === true ? ["--allow-downgrade"] : []),
      ]);
      return { ...plan, handedOff: true };
    }
    if (installed && start) {
      if (currentInstalled) yield* runSteps(manager.stop);
      if (Option.isSome(legacy)) yield* runSteps(legacy.value.manager.stop);
    }

    let wroteSelection = false;
    let selectionState: Option.Option<string> = Option.none();
    let selectionPending: Option.Option<string> = Option.none();
    const restoreSelection = Effect.gen(function* () {
      if (!wroteSelection) return;
      if (Option.isSome(selectionState)) {
        yield* writeDurably(statePath, selectionState.value);
      } else {
        yield* fs.remove(statePath, { force: true }).pipe(Effect.ignore);
      }
      if (Option.isSome(selectionPending)) {
        yield* fs.writeFileString(restartPendingPath, selectionPending.value, { mode: 0o600 });
      } else {
        yield* fs.remove(restartPendingPath, { force: true }).pipe(Effect.ignore);
      }
    }).pipe(Effect.ignore);

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
      selectionState = yield* fs.readFileString(statePath).pipe(Effect.option);
      selectionPending = yield* fs.readFileString(restartPendingPath).pipe(Effect.option);
      // Files can match the new version even when activation fails; keep that install retryable.
      yield* fs.writeFileString(restartPendingPath, `${input.cliVersion}\n`, { mode: 0o600 });
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
      wroteSelection = true;
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
        const begunAt = yield* Clock.currentTimeMillis;
        yield* runSteps(manager.activate);
        yield* awaitServiceAnswer(manager, begunAt);
        yield* fs.remove(restartPendingPath, { force: true });
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
      ),
      Effect.tapError(() => {
        if (!start) return Effect.void;
        if (currentInstalled) return runSteps(manager.restart).pipe(Effect.ignore);
        // The legacy launcher reads activeVersion at startup. Put the previous
        // selection back before it starts, or it clears the marker and runs
        // the new server under the old unit.
        if (Option.isSome(legacy))
          return reinstateLegacyUnit(manager, legacy.value, restoreSelection);
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
      if (Option.isNone(legacy)) return "skipped" as const;
      // Move the legacy unit to the new names without changing the version it starts.
      yield* runSteps(legacy.value.manager.stop);
      const begunAt = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
        yield* writeDurably(unitPath, migrateLegacyBootServiceUnit(legacy.value.contents));
        yield* retireLegacyUnit(legacy.value);
        yield* runSteps(manager.activate);
        yield* awaitServiceAnswer(manager, begunAt);
      }).pipe(Effect.tapError(() => reinstateLegacyUnit(manager, legacy.value)));
      yield* fs.remove(restartPendingPath, { force: true });
      return "restarted" as const;
    }
    const installedBaseDir = bootServiceBaseDirOf(unit.value);
    if (!servesThisHome(installedBaseDir)) {
      return "skipped" as const;
    }
    // Writes no state, and the launcher lets an update transition in flight
    // finish before the queued stop tears it down.
    if (runningInsideService && manager.handoff !== undefined) {
      yield* runSteps(manager.handoff);
      return "queued" as const;
    }
    yield* runSteps(manager.stop);
    const begunAt = yield* Clock.currentTimeMillis;
    // A legacy unit left behind next to the current one would start a second server at boot.
    const retireLeftover = Option.isSome(legacy)
      ? runSteps(legacy.value.manager.stop).pipe(Effect.andThen(retireLegacyUnit(legacy.value)))
      : Effect.void;
    yield* retireLeftover.pipe(
      Effect.andThen(runSteps(manager.activate)),
      Effect.andThen(awaitServiceAnswer(manager, begunAt)),
      Effect.tapError(() => runSteps(manager.restart).pipe(Effect.ignore)),
    );
    yield* fs.remove(restartPendingPath, { force: true });
    return "restarted" as const;
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "PlatformError" ? new BootServiceInstallError({ cause }) : cause,
    ),
    Effect.withSpan("cloud.boot_service.restart"),
  );

  const withStopped = Effect.fn("cloud.boot_service.with_stopped")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | BootServiceError, R> {
    if (detectedManager === undefined) return yield* operation;
    const current = yield* readCurrentUnit;
    const legacy = current._tag === "Owned" ? Option.none() : yield* readOwnedLegacyUnit;
    let manager: BootServiceManager;
    if (current._tag === "Owned") {
      manager = detectedManager;
    } else if (Option.isSome(legacy)) {
      manager = legacy.value.manager;
    } else {
      return yield* operation;
    }
    const unitFile = path.basename(manager.unitPath);
    const launchdLabel = path.basename(manager.unitPath, ".plist");
    // `is-active` fails while a crash-looping unit sits in `activating
    // (auto-restart)`, and a throttled launchd job is loaded without a pid;
    // both would start the server mid-repair. So the unit is always
    // stopped, and started again when it was active, enabled or loaded
    // before; a disabled unit caught crash-looping stays stopped.
    const restore =
      manager.kind === "systemd"
        ? yield* Effect.map(
            Effect.all(
              [
                probe("systemctl", ["--user", "is-enabled", unitFile]),
                probe("systemctl", ["--user", "is-active", unitFile]),
              ],
              { concurrency: "unbounded" },
            ),
            ([enabled, active]) => succeeded(active) || succeeded(enabled),
          )
        : succeeded(yield* probe("launchctl", ["print", `gui/${uid}/${launchdLabel}`]));
    return yield* Effect.acquireUseRelease(
      // Every stop step is required when the service is to be restored: a
      // step that was fine to skip during uninstall would leave the server
      // holding the database. A stop that fails (a timeout, say) may still
      // have stopped the service, so the restore below runs either way.
      // Nothing to restore means nothing is expected to be loaded, and the
      // stop is best-effort (launchd's bootout fails on an unloaded job).
      runSteps(manager.stop.map((step) => ({ ...step, optional: !restore }))).pipe(Effect.exit),
      (stopped): Effect.Effect<A, E | BootServiceError, R> =>
        Exit.isSuccess(stopped) ? operation : Effect.failCause(stopped.cause),
      (_, exit) => {
        if (!restore) return Effect.void;
        // Start only: `activate` would also enable a unit the user disabled.
        // When the operation itself failed, its error is the one worth reporting.
        const start = runSteps(manager.restart);
        return Exit.isFailure(exit) ? Effect.ignore(start) : start;
      },
    );
  });

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const current = yield* readCurrentUnit;
    const legacy = yield* readOwnedLegacyUnit;
    if (current._tag !== "Owned" && Option.isNone(legacy)) return false;
    if (current._tag === "Owned") {
      yield* runSteps(manager.deactivate);
      yield* fs
        .remove(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    }
    if (Option.isSome(legacy)) yield* retireLegacyUnit(legacy.value);
    if (current._tag === "Owned" || Option.isSome(legacy)) yield* runSteps(manager.finalize);
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
      // The goat.service branch reports this; skipping it here makes `goat update`
      // treat a legacy unit that is still on the previous server as already current.
      if (yield* fs.exists(restartPendingPath)) problems.push("restart-pending");
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
    if (!servesThisHome(installedBaseDir)) {
      return {
        supported: true,
        installed: false,
        current: false,
        ...(installedBaseDir === undefined ? {} : { installedBaseDir }),
        unitPath,
        logPath,
      };
    }
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

  return BootService.of({ install, restart, withStopped, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));
