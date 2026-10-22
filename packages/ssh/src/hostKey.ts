import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readOnlySshArgs, readOnlyProxyJumpArgs } from "./probeOptions.ts";
import { resolveSshCommand } from "./command.ts";
import { collectPreflightOutput } from "./preflightProcess.ts";
import { SshHostKeyProbeError } from "./errors.ts";

/** Collects the destination key OpenSSH negotiated, using only a disposable known_hosts. */
export const probeHostKey = Effect.fn("ssh/hostKey.probeHostKey")(function* (input: {
  readonly target: string;
  readonly user?: string;
  readonly port?: number;
  readonly resolvedSettings?: ReadonlyMap<string, string>;
}) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      if (
        !input.target.trim() ||
        input.target.startsWith("-") ||
        /[\r\n\0]/u.test(input.target) ||
        (input.user !== undefined && /[\r\n\0]/u.test(input.user)) ||
        (input.port !== undefined &&
          (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535))
      )
        return yield* new SshHostKeyProbeError({ message: "Invalid SSH probe target." });
      const ssh = yield* resolveSshCommand;
      const args = [
        ...(input.user === undefined ? [] : ["-l", input.user]),
        ...(input.port === undefined ? [] : ["-p", String(input.port)]),
      ];
      const run = (command: string, commandArgs: string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(command, commandArgs, { forceKillAfter: 2_000 }),
            );
            const [stdout, stderr, code] = yield* Effect.all(
              [
                collectPreflightOutput(child.stdout),
                collectPreflightOutput(child.stderr),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return { stdout, stderr, code: Number(code) };
          }),
        ).pipe(Effect.timeout("20 seconds"));
      // Resolving and connecting use the same original alias and overrides, preserving jump rules.
      const resolved = input.resolvedSettings
        ? { code: 0, stdout: "" }
        : yield* run(ssh, ["-G", ...args, input.target]);
      if (resolved.code !== 0)
        return yield* new SshHostKeyProbeError({ message: "Could not resolve SSH settings." });
      const settings =
        input.resolvedSettings ??
        new Map(
          resolved.stdout.split(/\r?\n/u).map((line) => {
            const [key = "", ...value] = line.trim().split(/\s+/u);
            return [key.toLowerCase(), value.join(" ")] as const;
          }),
        );
      const hostname = settings.get("hostname");
      const port = settings.get("port");
      if (!hostname || !port)
        return yield* new SshHostKeyProbeError({ message: "Incomplete SSH settings." });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-host-key-" });
      yield* fs.chmod(directory, 0o700);
      const knownHosts = path.join(directory, "known_hosts");
      yield* fs.writeFileString(knownHosts, "", { mode: 0o600, flag: "wx" });
      yield* fs.chmod(knownHosts, 0o600);
      const probe = yield* run(ssh, [
        ...args,
        ...readOnlySshArgs,
        ...(yield* readOnlyProxyJumpArgs(ssh, settings)),
        "-o",
        "PreferredAuthentications=none",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile="${knownHosts.replaceAll("\\", "/").replaceAll('"', '\\"')}"`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "HashKnownHosts=no",
        "-o",
        "CheckHostIP=no",
        input.target,
        "exit",
        "0",
      ]);
      if (probe.code !== 0 && probe.code !== 255)
        return yield* new SshHostKeyProbeError({ message: "SSH host key exchange failed." });
      const lines = (yield* fs.readFileString(knownHosts))
        .split(/\r?\n/u)
        .filter((line) => line.trim() && !line.trim().startsWith("#"));
      if (lines.length !== 1)
        return yield* new SshHostKeyProbeError({
          message: "Expected one negotiated destination host key.",
        });
      const match =
        /^(\S+) (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})$/u.exec(
          lines[0]!,
        );
      const hostAlias = settings.get("hostkeyalias");
      const expectedHost = hostAlias && hostAlias !== "none" ? hostAlias : hostname;
      const expectedEntry = port === "22" ? expectedHost : `[${expectedHost}]:${port}`;
      if (match === null || match[1]!.toLowerCase() !== expectedEntry.toLowerCase())
        return yield* new SshHostKeyProbeError({
          message: "Invalid negotiated destination host key.",
        });
      const fingerprint = yield* run(ssh.endsWith(".exe") ? "ssh-keygen.exe" : "ssh-keygen", [
        "-E",
        "sha256",
        "-lf",
        knownHosts,
      ]);
      const fingerprintLines = fingerprint.stdout.trim().split(/\r?\n/u);
      const digest = /^\d+ (SHA256:[A-Za-z0-9+/]{43})\s/u.exec(fingerprintLines[0] ?? "")?.[1];
      if (fingerprint.code !== 0 || fingerprintLines.length !== 1 || digest === undefined)
        return yield* new SshHostKeyProbeError({
          message: "Could not fingerprint the negotiated SSH key.",
        });
      return { algorithm: match[2]!, key: match[3]!, fingerprint: digest };
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof SshHostKeyProbeError
        ? cause
        : new SshHostKeyProbeError({
            message: "Could not collect the SSH host key.",
            cause,
          }),
    ),
  );
});
