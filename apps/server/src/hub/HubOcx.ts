import { GoatHostStatusResult, hasCloudMachineAliasPrefix } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
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
import { type OcxLayout, prepareScript, resolveOcx } from "../opencodex/childPrepare.ts";
import { SAFE_LINK_ID } from "./opencodexSyncPlan.ts";

const MAX_BYTES = 256 * 1024;
const EXIT = /\n?__goat_ocx_exit=(\d+)\s*$/u;
/** Arguments are code-built; this keeps every one inert inside single quotes. */
const SAFE_ARG = /^[A-Za-z0-9_.:=/+-]+$/u;
export const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** OpenCodex mints `ocx_pair_` plus base64url; anything else never reaches a device script. */
const PAIRING_CODE = /^ocx_pair_[A-Za-z0-9_-]{16,128}$/u;
/** Git Bash (MINGW), MSYS and Cygwin all run on Windows, which Remote Link refuses. */
const WINDOWS_UNAME = /^(?:MINGW|MSYS|CYGWIN|Windows_NT)/iu;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);
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
    readonly device: (
      alias: string,
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
    /** `uname -s` on the device; undefined when it does not answer. */
    readonly devicePlatform: (alias: string) => Effect.Effect<DevicePlatform | undefined>;
    /**
     * `ocx hub invite --json` here, then `ocx connect <dataUrl> --pairing-code-stdin` on the
     * device over GOAT SSH. The one-use code travels only on stdin and is never returned.
     */
    readonly connectHubClient: (
      alias: string,
      timeoutMs: number,
    ) => Effect.Effect<HubClientHandoff, HubOcxError>;
    /** SHA256 fingerprint of GOAT's pinned host key for the alias, if GOAT pins one. */
    readonly pinnedFingerprint: (alias: string) => Effect.Effect<string | undefined>;
    /**
     * Makes the device ready to be a Child: installs `version` for this user when OpenCodex is
     * missing or older than Remote Link supports, then starts it unless it already answers.
     * Stdout carries the version that answers; the code is one of `PREPARE_EXIT`.
     */
    readonly prepareDevice: (
      alias: string,
      version: string,
      timeoutMs: number,
    ) => Effect.Effect<OcxOutput, HubOcxError>;
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

  const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    runner.run({
      command,
      args,
      env: environment,
      cwd,
      timeout: timeoutMs,
      maxOutputBytes: MAX_BYTES,
      timeoutBehavior: "timedOutResult",
    });

  const home = Effect.fn("HubOcx.home")(function* (args: ReadonlyArray<string>, timeoutMs: number) {
    const binary = (yield* inventory.read).binaries[0]?.path;
    if (binary === undefined)
      return yield* new HubOcxError({
        reason: "ocx_missing",
        message: "OpenCodex is not installed on this hub.",
      });
    const output = yield* run(binary, args, timeoutMs).pipe(
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

  return HubOcx.of({
    home,
    device: (alias, args, timeoutMs) => runDevice(alias, deviceScript(args), timeoutMs),
    prepareDevice: (alias, version, timeoutMs) =>
      runDevice(alias, prepareScript(version), timeoutMs),
    syncDevice: (alias, options, timeoutMs) =>
      runDevice(alias, guardedSyncScript(options.linkId, options.restartCodex), timeoutMs),
    devicePlatform: Effect.fn("HubOcx.devicePlatform")(
      function* (alias) {
        const result = yield* dispatch.runHostScript({
          host: alias,
          script: platformScript,
          timeoutMs: 30_000,
        });
        const output = parseDeviceOutput(result.stdout);
        return output?.code === 0 ? platformOf(output.stdout) : undefined;
      },
      Effect.orElseSucceed(() => undefined),
    ),
    connectHubClient: Effect.fn("HubOcx.connectHubClient")(function* (alias, timeoutMs) {
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
      const connect = yield* runDevice(
        alias,
        deviceScript(
          [
            "connect",
            invite.dataUrl,
            "--management-url",
            invite.managementUrl,
            "--pairing-code-stdin",
          ],
          invite.code,
        ),
        timeoutMs,
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
