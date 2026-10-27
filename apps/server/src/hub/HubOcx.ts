import {
  ChildReadyConnectionResult,
  type ChildReadyConnectionInput,
  type EnvironmentId,
  GoatHostStatusResult,
  hasCloudMachineAliasPrefix,
  OrchestratorMcpFailure,
  type RuntimeMode,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- operation ids are random identifiers.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import { interruptibleTurns } from "../mcp/hostStatusModel.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { type OcxLayout, resolveOcx } from "../opencodex/childPrepare.ts";
import { SAFE_LINK_ID } from "./opencodexSyncPlan.ts";

const MAX_BYTES = 256 * 1024;
const EXIT = /\n?__goat_ocx_exit=(\d+)\s*$/u;
/** Arguments are code-built; this keeps every one inert inside single quotes. */
const SAFE_ARG = /^[A-Za-z0-9_.:=/+-]+$/u;
export const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** OpenCodex mints `ocx_pair_` plus base64url; anything else never reaches a device script. */
const PAIRING_CODE = /^ocx_pair_[A-Za-z0-9_-]{16,128}$/u;
/** Git Bash, MSYS and Cygwin kernel names identify a Windows device. */
const WINDOWS_UNAME = /^(?:MINGW|MSYS|CYGWIN|Windows_NT)/iu;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);
const decodeConnection = Schema.decodeUnknownEffect(ChildReadyConnectionResult);
const Invite = Schema.Struct({
  code: Schema.String,
  expiresAt: Schema.String,
  dataUrl: Schema.String,
  managementUrl: Schema.String,
});
const decodeInvite = Schema.decodeUnknownOption(Schema.fromJsonString(Invite));

/** `guardedSyncScript` exit codes besides ocx's own. */
export const SYNC_EXIT = { notConnected: 90, connectionChanged: 91 } as const;

export interface OcxOutput {
  readonly code: number;
  readonly stdout: string;
  /** OpenCodex's machine-readable failure code from stderr, never free text. */
  readonly phase?: string;
}

export class HubOcxError extends Data.TaggedError("HubOcxError")<{
  readonly reason: "ocx_missing" | "unreachable";
  readonly message: string;
}> {}

export type DevicePlatform = "windows" | "posix";

/**
 * One membership operation's authority for the Child's goat_hub_child_connection. It lives only
 * on this Home; the Child sees an ordinary hub.manage session and never a setup purpose.
 */
export interface HubChildConnectionAdmission {
  readonly homeEnvironmentId: EnvironmentId;
  /** The Child lets this operation restart right after its own disconnect, and nothing else. */
  readonly operationId: string;
  /** Rechecks the caller before the session is chosen and again right before each request. */
  readonly authorize: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>;
}

/** `allowed` is the caller's live permission, read again for every Child connection call. */
export const childConnectionAdmission = (
  homeEnvironmentId: EnvironmentId,
  allowed: Effect.Effect<boolean, OrchestratorMcpFailure>,
): HubChildConnectionAdmission => ({
  homeEnvironmentId,
  operationId: NodeCrypto.randomUUID(),
  authorize: Effect.flatMap(allowed, (ok) =>
    ok
      ? Effect.succeed("approval-required" as const)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Permission for this membership change was withdrawn.",
          }),
        ),
  ),
});

/**
 * The pairing code exists only inside this result's producer; callers see whether one was
 * minted and how `ocx connect` exited.
 */
export type HubClientHandoff =
  | { readonly minted: false; readonly exit: number; readonly phase?: string }
  | {
      readonly minted: true;
      readonly dataUrl: string;
      readonly expiresAt: string;
      readonly connect: OcxOutput;
    };

/** The only seam to OpenCodex and SSH; tests replace it with a scripted runner. */
export class HubOcx extends Context.Service<
  HubOcx,
  {
    readonly home: (
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
    /**
     * `home` for a join nobody is asked about: `admit` is read after every other wait, right
     * before ocx starts. False starts nothing and answers undefined.
     */
    readonly homeAdmitted: (
      args: ReadonlyArray<string>,
      timeoutMs: number,
      admit: Effect.Effect<boolean>,
    ) => Effect.Effect<OcxOutput | undefined, HubOcxError>;
    readonly device: (
      alias: string,
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
    /** `uname -s` on the device; undefined when it does not answer. */
    readonly devicePlatform: (alias: string) => Effect.Effect<DevicePlatform | undefined>;
    /**
     * `ocx hub invite --json` here, then goat_hub_child_connection on the device, whose GOAT
     * feeds the code to `ocx connect --pairing-code-stdin`. The one-use code never comes back.
     */
    readonly connectHubClient: (
      alias: string,
      timeoutMs: number,
      admission: HubChildConnectionAdmission,
    ) => Effect.Effect<HubClientHandoff, HubOcxError>;
    /**
     * Connects, disconnects or restarts the device's OpenCodex through its own GOAT's
     * goat_hub_child_connection, which selects the executable there. A POSIX device whose GOAT
     * does not serve that tool disconnects and restarts through the ocx script instead.
     */
    readonly connection: (
      alias: string,
      operation: ChildReadyConnectionInput["opencodexConnection"],
      timeoutMs: number,
      admission: HubChildConnectionAdmission,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
    /** SHA256 fingerprint of GOAT's pinned host key for the alias, if GOAT pins one. */
    readonly pinnedFingerprint: (alias: string) => Effect.Effect<string | undefined>;
    /**
     * Attaches to, or provisions, GOAT's runtime on the device the way SSH setup does, never
     * replacing a running one. False while it is pending or has no usable executable.
     */
    readonly ensureDeviceRuntime: (alias: string) => Effect.Effect<boolean, HubOcxError>;
    /**
     * `ocx sync` on a Remote Link Child, only while it is connected over `linkId`. Stdout is
     * what ocx printed; the code is ocx's own or one of `SYNC_EXIT`.
     */
    readonly syncDevice: (
      alias: string,
      options: { readonly linkId: string; readonly restartCodex: boolean },
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
    /** False when `ssh -G` shows a jump chain or proxy command, or cannot resolve the alias. */
    readonly directAlias: (alias: string) => Effect.Effect<boolean>;
    /** Running turns on the device, subagents included; undefined when it cannot be read. */
    readonly runningTurns: (
      alias: string,
      scope: McpInvocationScope,
    ) => Effect.Effect<number | undefined>;
    /** The device's own `GET /healthz` body over GOAT SSH; undefined when it does not answer. */
    readonly deviceHealth: (alias: string) => Effect.Effect<string | undefined>;
    /** Live `ssh -R` link tunnels on this Home for the alias or port; undefined when unreadable. */
    readonly homeTunnels: (
      /** Undefined counts by port alone, so a newer link under the alias is not counted. */
      alias: string | undefined,
      tunnelPort: number | undefined,
    ) => Effect.Effect<number | undefined>;
  }
>()("goat/hub/HubOcx") {}

const phaseOf = (stderr: string) =>
  /\b((?:remote|child|home)_[a-z_]{2,60}|link_not_found)\b/u.exec(stderr)?.[1];

export const platformOf = (uname: string): DevicePlatform | undefined => {
  const name = uname.trim();
  return name === "" ? undefined : WINDOWS_UNAME.test(name) ? "windows" : "posix";
};

/**
 * A pairing code goes to ocx's stdin through the shell's printf builtin, so it is never in argv.
 */
export const deviceScript = (args: ReadonlyArray<string>, pairingCode?: string) => {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new TypeError("Unsafe ocx argument.");
  if (pairingCode !== undefined && !PAIRING_CODE.test(pairingCode))
    throw new TypeError("Unexpected pairing code shape.");
  const quoted = args.map((arg) => `'${arg}'`).join(" ");
  // The script arrives on sh's stdin, so ocx must not read it.
  const invoke =
    pairingCode === undefined
      ? `"$goat_ocx" ${quoted} </dev/null 2>/dev/null`
      : `printf '%s\\n' '${pairingCode}' | "$goat_ocx" ${quoted} 2>/dev/null`;
  return [
    ...resolveOcx(),
    "if [ -z \"$goat_ocx\" ]; then printf '\\n__goat_ocx_exit=127\\n'; exit 0; fi",
    invoke,
    "printf '\\n__goat_ocx_exit=%s\\n' \"$?\"",
    "",
  ].join("\n");
};

const platformScript = "uname -s 2>/dev/null\nprintf '\\n__goat_ocx_exit=%s\\n' \"$?\"\n";

/**
 * `ocx sync` falls back to the machine's own providers once it is no longer connected, and it
 * cannot be told which link to expect (lidge-jun/opencodex#7694). So the script reads
 * `ocx connect status --json` right before the sync and refuses unless it is connected over this
 * link, then reads it again so a connection that moved during the run is never reported synced.
 * OpenCodex prints that status as two-space JSON, which the anchored patterns rely on.
 */
export const guardedSyncScript = (linkId: string, restartCodex: boolean, layout?: OcxLayout) => {
  if (!SAFE_LINK_ID.test(linkId)) throw new TypeError("Unsafe link id.");
  return [
    ...resolveOcx(layout),
    "if [ -z \"$goat_ocx\" ]; then printf '\\n__goat_ocx_exit=127\\n'; exit 0; fi",
    "goat_linked() {",
    '  goat_status=$("$goat_ocx" connect status --json </dev/null 2>/dev/null) || return 1',
    '  printf \'%s\\n\' "$goat_status" | grep -q \'^  "state": "connected",\\{0,1\\}$\' || return 1',
    '  printf \'%s\\n\' "$goat_status" | grep -q \'^  "transport": "link",\\{0,1\\}$\' || return 1',
    `  printf '%s\\n' "$goat_status" | grep -q '^    "linkId": "${linkId}",\\{0,1\\}$'`,
    "}",
    `if ! goat_linked; then printf '\\n__goat_ocx_exit=${SYNC_EXIT.notConnected}\\n'; exit 0; fi`,
    `goat_out=$("$goat_ocx" sync${restartCodex ? " --restart-codex" : ""} </dev/null 2>/dev/null)`,
    "goat_code=$?",
    `if ! goat_linked; then printf '\\n__goat_ocx_exit=${SYNC_EXIT.connectionChanged}\\n'; exit 0; fi`,
    'printf \'%s\\n__goat_ocx_exit=%s\\n\' "$goat_out" "$goat_code"',
    "",
  ].join("\n");
};

export const parseDeviceOutput = (stdout: string): OcxOutput | undefined => {
  const match = EXIT.exec(stdout);
  if (match === null) return undefined;
  return { code: Number(match[1]), stdout: stdout.slice(0, match.index) };
};

/** Waits up to 15 seconds for the restarted runtime on the port OpenCodex's config names. */
export const healthScript = [
  'goat_config="${OPENCODEX_HOME:-$HOME/.opencodex}/config.json"',
  'goat_port=$(sed -n \'s/^[[:space:]]*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' "$goat_config" 2>/dev/null | head -n 1)',
  '[ -n "$goat_port" ] || goat_port=10100',
  "goat_try=0",
  'while [ "$goat_try" -lt 15 ]; do',
  '  if goat_body=$(curl -fsS --max-time 3 "http://127.0.0.1:$goat_port/healthz" </dev/null 2>/dev/null); then',
  "    printf '%s\\n__goat_ocx_exit=0\\n' \"$goat_body\"; exit 0",
  "  fi",
  "  goat_try=$((goat_try + 1)); sleep 1",
  "done",
  "printf '\\n__goat_ocx_exit=7\\n'",
  "",
].join("\n");

/** OpenCodex runs each link tunnel as `ssh … -R 127.0.0.1:<port>:127.0.0.1:<home> -- <alias>`. */
export const countLinkTunnels = (
  processes: string,
  alias: string | undefined,
  tunnelPort: number | undefined,
) =>
  processes.split(/\r?\n/u).filter((line) => {
    const argv = line.trim().split(/\s+/u);
    if (!/(^|\/)ssh$/u.test(argv[0] ?? "")) return false;
    const forward = argv[argv.indexOf("-R") + 1];
    if (!argv.includes("-R") || forward === undefined) return false;
    return (
      (tunnelPort !== undefined && forward.startsWith(`127.0.0.1:${tunnelPort}:`)) ||
      (alias !== undefined && argv.at(-2) === "--" && argv.at(-1) === alias)
    );
  }).length;

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const inventory = yield* Inventory.OpenCodexInventory;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const cwd = yield* HostProcess.WorkingDirectory;

  const run = (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    workingDirectory: string | null = cwd,
  ) =>
    runner.run({
      command,
      args,
      env: environment,
      cwd: workingDirectory ?? undefined,
      timeout: timeoutMs,
      maxOutputBytes: MAX_BYTES,
      timeoutBehavior: "timedOutResult",
    });

  const homeBinary = Effect.fn("HubOcx.homeBinary")(function* () {
    const binary = (yield* inventory.read).binaries[0]?.path;
    if (binary === undefined)
      return yield* new HubOcxError({
        reason: "ocx_missing",
        message: "OpenCodex is not installed on this hub.",
      });
    return binary;
  });
  const home = Effect.fn("HubOcx.home")(function* (args: ReadonlyArray<string>, timeoutMs: number) {
    return yield* runHome(yield* homeBinary(), args, timeoutMs);
  });
  const homeAdmitted = Effect.fn("HubOcx.homeAdmitted")(function* (
    args: ReadonlyArray<string>,
    timeoutMs: number,
    admit: Effect.Effect<boolean>,
  ) {
    const binary = yield* homeBinary();
    if (!(yield* admit)) return undefined;
    // No working directory: the spawner awaits a check of one before it starts the process, and
    // nothing may wait between the permission read and the start. The binary path is absolute.
    return yield* runHome(binary, args, timeoutMs, null);
  });
  const runHome = Effect.fn("HubOcx.runHome")(function* (
    binary: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    workingDirectory: string | null = cwd,
  ) {
    const output = yield* run(binary, args, timeoutMs, workingDirectory).pipe(
      Effect.mapError(
        () => new HubOcxError({ reason: "unreachable", message: "ocx could not be run here." }),
      ),
    );
    const phase = phaseOf(output.stderr);
    return {
      code: output.timedOut ? 124 : (output.code ?? 1),
      stdout: output.stdoutTruncated ? "" : output.stdout,
      ...(phase === undefined ? {} : { phase }),
    } satisfies OcxOutput;
  });

  const runDevice = Effect.fn("HubOcx.runDevice")(function* (
    alias: string,
    script: string,
    timeoutMs: number,
  ) {
    const result = yield* dispatch.runHostScript({ host: alias, script, timeoutMs }).pipe(
      Effect.mapError(
        (error) =>
          new HubOcxError({
            reason: "unreachable",
            message: `${alias} could not be reached over SSH (${error.reason}).`,
          }),
      ),
    );
    const output = parseDeviceOutput(result.stdout);
    if (output === undefined)
      return yield* new HubOcxError({
        reason: "unreachable",
        message: `${alias} did not finish the ocx command.`,
      });
    if (output.code === 127)
      return yield* new HubOcxError({
        reason: "ocx_missing",
        message: `OpenCodex is not installed on ${alias}.`,
      });
    return output;
  });

  const devicePlatform = Effect.fn("HubOcx.devicePlatform")(
    function* (alias: string) {
      const result = yield* dispatch.runHostScript({
        host: alias,
        script: platformScript,
        timeoutMs: 30_000,
      });
      const output = parseDeviceOutput(result.stdout);
      return output?.code === 0 ? platformOf(output.stdout) : undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const refused = (message: string) => new HubOcxError({ reason: "unreachable", message });
  const authorized = (admission: HubChildConnectionAdmission) =>
    admission.authorize.pipe(
      Effect.mapError(() => refused("Approval for this membership change is no longer active.")),
    );
  /** The device's own GOAT runs the change; `unserved` when no GOAT there has the tool. */
  const childConnection = Effect.fn("HubOcx.childConnection")(function* (
    alias: string,
    operation: ChildReadyConnectionInput["opencodexConnection"],
    timeoutMs: number,
    admission: HubChildConnectionAdmission,
  ) {
    const identify = dispatch
      .identifyTarget({ alias, hostname: alias, username: null, port: null })
      .pipe(Effect.orElseSucceed(() => null));
    // A device without a GOAT runtime attached yet gets one, as setup does, then names itself.
    const destination =
      (yield* identify) ??
      ((yield* dispatch.ensureRuntime(alias).pipe(Effect.orElseSucceed(() => false)))
        ? yield* identify
        : null);
    if (destination === null) return { unserved: `GOAT on ${alias} did not identify itself.` };
    const input: ChildReadyConnectionInput = {
      destinationEnvironmentId: destination,
      homeEnvironmentId: admission.homeEnvironmentId,
      operationId: admission.operationId,
      opencodexConnection: operation,
    };
    const answer = yield* dispatch
      .callHostTool(
        {
          host: alias,
          environmentId: destination,
          tool: "goat_hub_child_connection",
          arguments: { ...input },
          writes: true,
          timeoutMs,
        },
        admission.authorize,
      )
      .pipe(Effect.result);
    if (answer._tag === "Failure")
      return answer.failure._tag === "SshRemoteDispatchError" &&
        answer.failure.reason === "remote_outdated"
        ? { unserved: `Update GOAT on ${alias}; it cannot change its OpenCodex connection yet.` }
        : yield* refused(
            `${alias} refused the connection change; check its membership before retrying.`,
          );
    const result = yield* decodeConnection(answer.success).pipe(
      Effect.mapError(() => refused(`Update GOAT on ${alias}; its answer was not understood.`)),
    );
    if (
      result.destinationEnvironmentId !== destination ||
      result.homeEnvironmentId !== input.homeEnvironmentId ||
      result.operationId !== input.operationId ||
      result.kind !== operation.kind
    )
      return yield* refused(`${alias} answered for another connection change.`);
    return { code: result.code, stdout: "" } satisfies OcxOutput;
  });

  const connection = Effect.fn("HubOcx.connection")(function* (
    alias: string,
    operation: ChildReadyConnectionInput["opencodexConnection"],
    timeoutMs: number,
    admission: HubChildConnectionAdmission,
  ) {
    // Uncertain outcomes need membership reconciliation, never a retried invite or a script.
    yield* authorized(admission);
    const served = yield* childConnection(alias, operation, timeoutMs, admission);
    if (!("unserved" in served)) return served;
    // Nothing ran there. OpenCodex alone or an older GOAT on a POSIX device still disconnects
    // and restarts through the ocx script that preceded the tool; Windows needs the tool.
    if (operation.kind === "connectHubClient" || (yield* devicePlatform(alias)) !== "posix")
      return yield* refused(served.unserved);
    yield* authorized(admission);
    return yield* runDevice(
      alias,
      deviceScript(operation.kind === "disconnect" ? ["disconnect", "--json"] : ["restart"]),
      timeoutMs,
    );
  });

  return HubOcx.of({
    connection,
    home,
    homeAdmitted,
    device: (alias, args, timeoutMs) => runDevice(alias, deviceScript(args), timeoutMs),
    ensureDeviceRuntime: Effect.fn("HubOcx.ensureDeviceRuntime")(function* (alias) {
      return yield* dispatch.ensureRuntime(alias).pipe(
        Effect.mapError(
          (error) =>
            new HubOcxError({
              reason: "unreachable",
              message: `${alias} could not be reached over SSH (${error.reason}).`,
            }),
        ),
      );
    }),
    syncDevice: (alias, options, timeoutMs) =>
      runDevice(alias, guardedSyncScript(options.linkId, options.restartCodex), timeoutMs),
    devicePlatform,
    connectHubClient: Effect.fn("HubOcx.connectHubClient")(function* (alias, timeoutMs, admission) {
      // Nothing is minted for a caller whose approval already ended.
      yield* authorized(admission);
      const minted = yield* home(["hub", "invite", "--json"], 60_000);
      const invite =
        minted.code === 0 ? Option.getOrUndefined(decodeInvite(minted.stdout.trim())) : undefined;
      // A shape this script cannot quote safely is refused; the unused code expires on its own.
      if (
        invite === undefined ||
        !PAIRING_CODE.test(invite.code) ||
        !SAFE_ARG.test(invite.dataUrl) ||
        !SAFE_ARG.test(invite.managementUrl)
      )
        return {
          minted: false as const,
          exit: minted.code === 0 ? 1 : minted.code,
          ...(minted.phase === undefined ? {} : { phase: minted.phase }),
        };
      const connect = yield* connection(
        alias,
        {
          kind: "connectHubClient",
          dataUrl: invite.dataUrl,
          managementUrl: invite.managementUrl,
          pairingCode: invite.code,
        },
        timeoutMs,
        admission,
      );
      return {
        minted: true as const,
        dataUrl: invite.dataUrl,
        expiresAt: invite.expiresAt,
        connect,
      };
    }),
    pinnedFingerprint: Effect.fn("HubOcx.pinnedFingerprint")(
      function* (alias) {
        if (!SAFE_ALIAS.test(alias)) return undefined;
        // A cloud alias is only ever pinned by the cloud machine service, never by a person.
        const directories = hasCloudMachineAliasPrefix(alias)
          ? ["goat-cloud"]
          : ["goat-hosts", "goat-cloud"];
        for (const directory of directories) {
          const file = path.join(homeDirectory, ".ssh", directory, `${alias}.known_hosts`);
          if (!(yield* fs.exists(file))) continue;
          const output = yield* run("ssh-keygen", ["-E", "sha256", "-lf", file], 10_000);
          const lines = output.stdout.trim().split(/\r?\n/u);
          const fingerprint = /^\d+ (SHA256:[A-Za-z0-9+/]{43})\s/u.exec(lines[0] ?? "")?.[1];
          // A pin file holding several keys does not name one key to expect.
          return output.code === 0 && lines.length === 1 ? fingerprint : undefined;
        }
        return undefined;
      },
      Effect.orElseSucceed(() => undefined),
    ),
    directAlias: Effect.fn("HubOcx.directAlias")(
      function* (alias) {
        if (!SAFE_ALIAS.test(alias)) return false;
        const output = yield* run("ssh", ["-G", alias], 10_000);
        if (output.code !== 0 || output.timedOut) return false;
        const settings = new Map(
          output.stdout.split(/\r?\n/u).map((line) => {
            const [key = "", ...value] = line.trim().split(/\s+/u);
            return [key.toLowerCase(), value.join(" ")] as const;
          }),
        );
        // A jump chain is what missed OpenCodex's 15-second link admission window.
        return [settings.get("proxyjump"), settings.get("proxycommand")].every(
          (value) => value === undefined || value === "" || value === "none",
        );
      },
      Effect.orElseSucceed(() => false),
    ),
    runningTurns: Effect.fn("HubOcx.runningTurns")(
      function* (alias, scope) {
        const status = yield* hosts.readOnHost(
          scope,
          {
            host: alias,
            tool: "goat_host_status",
            arguments: { local: true },
            timeoutMs: 10_000,
          },
          decodeStatus,
        );
        const entry = status.hosts.find(({ host }) => host === null);
        const threads =
          entry?.reachability === "ok" && !entry.lastKnown ? entry.metrics?.threads : undefined;
        return threads === undefined ? undefined : interruptibleTurns(threads);
      },
      Effect.orElseSucceed(() => undefined),
    ),
    deviceHealth: Effect.fn("HubOcx.deviceHealth")(
      function* (alias) {
        const result = yield* dispatch.runHostScript({
          host: alias,
          script: healthScript,
          timeoutMs: 30_000,
        });
        const output = parseDeviceOutput(result.stdout);
        return output?.code === 0 ? output.stdout : undefined;
      },
      Effect.orElseSucceed(() => undefined),
    ),
    homeTunnels: Effect.fn("HubOcx.homeTunnels")(
      function* (alias, tunnelPort) {
        const output = yield* run("ps", ["-axww", "-o", "command="], 10_000);
        return output.code === 0 && !output.stdoutTruncated
          ? countLinkTunnels(output.stdout, alias, tunnelPort)
          : undefined;
      },
      Effect.orElseSucceed(() => undefined),
    ),
  });
});

export const layer = Layer.effect(HubOcx, make);
