import { GoatHostStatusResult } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";

const MAX_BYTES = 256 * 1024;
const EXIT = /\n?__goat_ocx_exit=(\d+)\s*$/u;
/** Arguments are code-built; this keeps every one inert inside single quotes. */
const SAFE_ARG = /^[A-Za-z0-9_.:=/+-]+$/u;
export const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const decodeStatus = Schema.decodeUnknownEffect(GoatHostStatusResult);

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
    /** SHA256 fingerprint of GOAT's pinned host key for the alias, if GOAT pins one. */
    readonly pinnedFingerprint: (alias: string) => Effect.Effect<string | undefined>;
    /** False when `ssh -G` shows a jump chain or proxy command, or cannot resolve the alias. */
    readonly directAlias: (alias: string) => Effect.Effect<boolean>;
    /** Running turns on the device; undefined when it cannot be read. */
    readonly runningTurns: (
      alias: string,
      scope: McpInvocationScope,
    ) => Effect.Effect<number | undefined>;
  }
>()("goat/hub/HubOcx") {}

const phaseOf = (stderr: string) =>
  /\b((?:remote|child|home)_[a-z_]{2,60}|link_not_found)\b/u.exec(stderr)?.[1];

/** Resolves ocx in OpenCodex's remoteOcxArgv order: Desktop and system installs before PATH shims. */
export const deviceScript = (args: ReadonlyArray<string>) => {
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new TypeError("Unsafe ocx argument.");
  const quoted = args.map((arg) => `'${arg}'`).join(" ");
  // The script arrives on sh's stdin, so ocx must not read it.
  return [
    "goat_ocx=",
    'for goat_candidate in "$HOME/.opencodex-desktop/bin/ocx" /Applications/OpenCodex.app/Contents/MacOS/ocx /usr/bin/ocx; do',
    '  if [ -x "$goat_candidate" ]; then goat_ocx=$goat_candidate; break; fi',
    "done",
    'if [ -z "$goat_ocx" ]; then',
    '  PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"',
    "  goat_ocx=$(command -v ocx 2>/dev/null) || goat_ocx=",
    "fi",
    "if [ -z \"$goat_ocx\" ]; then printf '\\n__goat_ocx_exit=127\\n'; exit 0; fi",
    `"$goat_ocx" ${quoted} </dev/null 2>/dev/null`,
    "printf '\\n__goat_ocx_exit=%s\\n' \"$?\"",
    "",
  ].join("\n");
};

export const parseDeviceOutput = (stdout: string): OcxOutput | undefined => {
  const match = EXIT.exec(stdout);
  if (match === null) return undefined;
  return { code: Number(match[1]), stdout: stdout.slice(0, match.index) };
};

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

  return HubOcx.of({
    home: Effect.fn("HubOcx.home")(function* (args, timeoutMs) {
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
      };
    }),
    device: Effect.fn("HubOcx.device")(function* (alias, args, timeoutMs) {
      const result = yield* dispatch
        .runHostScript({ host: alias, script: deviceScript(args), timeoutMs })
        .pipe(
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
    }),
    pinnedFingerprint: Effect.fn("HubOcx.pinnedFingerprint")(
      function* (alias) {
        if (!SAFE_ALIAS.test(alias)) return undefined;
        for (const directory of ["goat-hosts", "goat-cloud"]) {
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
        return entry?.reachability === "ok" && !entry.lastKnown
          ? entry.metrics?.threads.running
          : undefined;
      },
      Effect.orElseSucceed(() => undefined),
    ),
  });
});

export const layer = Layer.effect(HubOcx, make);
