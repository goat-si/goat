import { CloudMachineError, isCloudMachineAlias } from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";
import type { BoatSshEndpoint } from "./BoatClient.ts";

/**
 * This computer's OpenSSH files for cloud machines. Each machine gets
 * ~/.ssh/goat-cloud/<alias>.conf and a pinned <alias>.known_hosts, reached through one Include
 * line at the top of ~/.ssh/config. Everything else in ~/.ssh/config is left byte for byte.
 */

export const CLOUD_SSH_INCLUDE = "Include ~/.ssh/goat-cloud/*.conf";
const INCLUDE_LINE = /^\s*Include\s+\S*goat-cloud\/\*\.conf\s*$/imu;

/** Puts the Include first, because OpenSSH keeps the first value it reads for each option. */
export function insertCloudInclude(source: string): string {
  if (INCLUDE_LINE.test(source)) return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.length === 0 ? CLOUD_SSH_INCLUDE + newline : CLOUD_SSH_INCLUDE + newline + source;
}

/** Resolution paths collected by the caller's ssh -G probe and retained by the approved alias. */
export type ManagedSshEndpoint = BoatSshEndpoint & {
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
};

const quote = (value: string) => `"${value.replaceAll('"', "")}"`;

export function renderCloudHost(input: {
  readonly alias: string;
  readonly endpoint: ManagedSshEndpoint;
  readonly identityFile?: string;
  readonly knownHostsFile: string;
}): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.alias)) throw new Error("Invalid SSH alias");
  return [
    `Host ${input.alias}`,
    `  HostName ${input.endpoint.host}`,
    `  Port ${input.endpoint.port}`,
    `  User ${input.endpoint.user}`,
    ...(input.endpoint.proxyJump === undefined || input.endpoint.proxyJump === "none"
      ? []
      : [`  ProxyJump ${input.endpoint.proxyJump}`]),
    ...(input.endpoint.proxyCommand === undefined || input.endpoint.proxyCommand === "none"
      ? []
      : [`  ProxyCommand ${input.endpoint.proxyCommand}`]),
    ...(input.identityFile === undefined
      ? []
      : [`  IdentityFile ${quote(input.identityFile)}`, "  IdentitiesOnly yes"]),
    `  HostKeyAlias ${input.alias}`,
    `  UserKnownHostsFile ${quote(input.knownHostsFile)}`,
    "  GlobalKnownHostsFile /dev/null",
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    `  HostKeyAlgorithms ${input.endpoint.hostKey.startsWith("ssh-rsa ") ? "rsa-sha2-512,rsa-sha2-256" : input.endpoint.hostKey.split(" ")[0]}`,
    "",
  ].join("\n");
}

/**
 * Checks `ssh -G <alias>` output: the pinned known_hosts file, strict checking and the host key
 * alias must be what GOAT wrote, or an earlier option in the user's config would win.
 */
export function effectiveSettingsMatch(
  output: string,
  expected: {
    readonly alias: string;
    readonly endpoint: ManagedSshEndpoint;
    readonly knownHostsFile: string;
    readonly identityFile?: string;
  },
): boolean {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const [key, ...rest] = line.trim().split(/\s+/u);
    if (key && rest.length > 0 && !values.has(key.toLowerCase()))
      values.set(key.toLowerCase(), rest.join(" "));
  }
  const strict = values.get("stricthostkeychecking");
  return (
    (strict === "true" || strict === "yes") &&
    (expected.identityFile === undefined ||
      ["yes", "true"].includes(values.get("identitiesonly") ?? "")) &&
    values.get("hostkeyalias") === expected.alias &&
    values.get("userknownhostsfile") === expected.knownHostsFile &&
    values.get("globalknownhostsfile") === "/dev/null" &&
    ["no", "false"].includes(values.get("updatehostkeys") ?? "") &&
    values.get("user") === expected.endpoint.user &&
    values.get("hostkeyalgorithms") ===
      (expected.endpoint.hostKey.startsWith("ssh-rsa ")
        ? "rsa-sha2-512,rsa-sha2-256"
        : expected.endpoint.hostKey.split(" ")[0]) &&
    (expected.endpoint.proxyJump === undefined ||
      values.get("proxyjump") === expected.endpoint.proxyJump) &&
    (expected.endpoint.proxyCommand === undefined ||
      values.get("proxycommand") === expected.endpoint.proxyCommand) &&
    values.get("hostname") === expected.endpoint.host &&
    values.get("port") === String(expected.endpoint.port) &&
    (expected.identityFile === undefined || values.get("identityfile") === expected.identityFile)
  );
}

/** Whether the user's own config already names this alias in a Host line. */
export function definesHostAlias(config: string, alias: string): boolean {
  return config.split(/\r?\n/u).some(
    (line) =>
      /^\s*Host(?:\s|=)/iu.test(line) &&
      line
        .split("#")[0]!
        .replace(/^\s*Host\s*=?\s*/iu, "")
        .split(/\s+/u)
        .some((value) => value.replace(/^["']|["']$/gu, "").toLowerCase() === alias.toLowerCase()),
  );
}

export class CloudMachineSsh extends Context.Service<
  CloudMachineSsh,
  {
    /** Adds the Include line to ~/.ssh/config once; the caller has the user's consent. */
    readonly installInclude: Effect.Effect<void, CloudMachineError>;
    /** GOAT's own key pair, created on first use; returns the public key. */
    readonly ensureKey: Effect.Effect<
      { readonly identityFile: string; readonly publicKey: string },
      CloudMachineError
    >;
    /**
     * Writes the alias's conf and pinned known_hosts, each atomically and private, then checks
     * that OpenSSH really uses them. Always rewrites, so the conf's mtime says when it was last
     * confirmed. `changed` is whether the address or host key differs from before.
     */
    readonly writeHost: (
      alias: string,
      endpoint: BoatSshEndpoint,
    ) => Effect.Effect<{ readonly changed: boolean }, CloudMachineError>;
    readonly removeHost: (alias: string) => Effect.Effect<void, CloudMachineError>;
  }
>()("goat/cloudMachines/sshConfig/CloudMachineSsh") {}

const failed = () => new CloudMachineError({ reason: "ssh_config_failed" });

export const makeManagedSshWriter = (options: {
  readonly home: string;
  readonly directory: "goat-cloud" | "goat-hosts";
  readonly isAlias: (alias: string) => boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const crypto = yield* Crypto.Crypto;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    const sshDir = path.join(options.home, ".ssh");
    const cloudDir = path.join(sshDir, options.directory);
    const configPath = path.join(sshDir, "config");
    const keyPath = path.join(cloudDir, "id_ed25519");
    const confPath = (alias: string) => path.join(cloudDir, `${alias}.conf`);
    const knownHostsPath = (alias: string) => path.join(cloudDir, `${alias}.known_hosts`);

    const ensureDirectory = (directory: string) =>
      fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.andThen(fs.chmod(directory, 0o700)));

    const readOptional = (file: string) =>
      fs
        .exists(file)
        .pipe(
          Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(null))),
        );
    const isSymlink = (file: string) =>
      fs.readLink(file).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    // Checked before any chmod, so a link never makes GOAT change another directory.
    const ensureCloudDirectory = isSymlink(cloudDir).pipe(
      Effect.flatMap((linked) =>
        linked ? Effect.fail(failed()) : ensureDirectory(cloudDir).pipe(Effect.mapError(failed)),
      ),
    );

    /** Same-directory temp file, created exclusively with mode 0600, then renamed into place. */
    const writePrivate = (file: string, contents: string) =>
      Effect.gen(function* () {
        const temp = `${file}.${yield* crypto.randomUUIDv4()}.tmp`;
        yield* fs.writeFileString(temp, contents, { mode: 0o600, flag: "wx" }).pipe(
          Effect.andThen(fs.chmod(temp, 0o600)),
          Effect.andThen(fs.rename(temp, file)),
          Effect.onError(() => fs.remove(temp, { force: true }).pipe(Effect.ignore)),
        );
      });

    const run = (command: string, args: ReadonlyArray<string>) =>
      runner.run({ command, args, timeout: "20 seconds" }).pipe(
        Effect.flatMap((output) =>
          output.code === 0 ? Effect.succeed(output.stdout) : Effect.fail(failed()),
        ),
        Effect.mapError(failed),
      );

    const installInclude = Effect.gen(function* () {
      yield* ensureDirectory(sshDir);
      const existing = yield* readOptional(configPath);
      const include = `Include ~/.ssh/${options.directory}/*.conf`;
      const source = existing ?? "";
      const present = source
        .split(/\r?\n/u)
        .some((line) => line.trim().replace(/\s+/gu, " ").toLowerCase() === include.toLowerCase());
      const next = present
        ? source
        : `${include}${source.includes("\r\n") ? "\r\n" : "\n"}${source}`;
      if (next === existing) return;
      const mode = existing === null ? 0o600 : (yield* fs.stat(configPath)).mode & 0o777;
      // Resolves a symlinked config (dotfile managers) and rewrites its target in place.
      yield* writeFileStringAtomically({ filePath: configPath, contents: next }).pipe(
        Effect.provide(context),
      );
      yield* fs.chmod(configPath, mode);
    }).pipe(Effect.mapError(failed));

    const ensureKey = Effect.gen(function* () {
      if (yield* isSymlink(sshDir)) return yield* failed();
      yield* ensureDirectory(sshDir).pipe(Effect.mapError(failed));
      yield* ensureCloudDirectory;
      const publicPath = `${keyPath}.pub`;
      // GOAT's key lives only here; a link could point SSH at some other identity.
      for (const file of [keyPath, publicPath]) if (yield* isSymlink(file)) return yield* failed();
      const [hasPrivate, hasPublic] = [yield* fs.exists(keyPath), yield* fs.exists(publicPath)];
      // Half a key pair is never completed or overwritten; the user has to look at it.
      if (hasPrivate !== hasPublic) return yield* failed();
      if (!hasPrivate)
        yield* run("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          options.directory,
          "-f",
          keyPath,
        ]);
      const publicKey = (yield* fs.readFileString(publicPath)).trim();
      if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( .*)?$/u.test(publicKey)) return yield* failed();
      return { identityFile: keyPath, publicKey };
    }).pipe(Effect.mapError(failed));

    // Follow Includes before writing: only this writer's exact conf is exempt from conflicts.
    const refuseShadowedHost = (alias: string) =>
      Effect.gen(function* () {
        const visited = new Set<string>();
        const inspect = (file: string): Effect.Effect<void, CloudMachineError> =>
          Effect.gen(function* () {
            const resolved = path.resolve(file);
            if (visited.has(resolved) || resolved === confPath(alias)) return;
            visited.add(resolved);
            const config = yield* readOptional(resolved).pipe(Effect.mapError(failed));
            if (config === null) return;
            if (definesHostAlias(config, alias))
              return yield* new CloudMachineError({ reason: "alias_conflict" });
            for (const line of config.split(/\r?\n/u)) {
              const match = /^\s*Include\s*=?\s+(.+)$/iu.exec(line.split("#")[0]!);
              if (match === null) continue;
              for (const token of match[1]!.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []) {
                const raw = token.replace(/^["']|["']$/gu, "").replace(/^~(?=\/|$)/u, options.home);
                const pattern = path.isAbsolute(raw) ? raw : path.join(sshDir, raw);
                const expand = (
                  parts: string[],
                  current: string,
                ): Effect.Effect<void, CloudMachineError> =>
                  Effect.gen(function* () {
                    const [part, ...rest] = parts;
                    if (part === undefined) return yield* inspect(current);
                    if (!/[?*]/u.test(part)) return yield* expand(rest, path.join(current, part));
                    if (!(yield* fs.exists(current).pipe(Effect.mapError(failed)))) return;
                    const regex = new RegExp(
                      `^${part
                        .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
                        .replaceAll("*", ".*")
                        .replaceAll("?", ".")}$`,
                      "u",
                    );
                    for (const entry of yield* fs
                      .readDirectory(current)
                      .pipe(Effect.mapError(failed)))
                      if (regex.test(entry)) yield* expand(rest, path.join(current, entry));
                  });
                const root = path.parse(pattern).root;
                yield* expand(pattern.slice(root.length).split(path.sep), root);
              }
            }
          });
        yield* inspect(configPath);
        // A missing Include does not make an existing Boat alias available to generic hosts.
        if (options.directory === "goat-hosts") {
          const boat = yield* readOptional(path.join(sshDir, "goat-cloud", `${alias}.conf`)).pipe(
            Effect.mapError(failed),
          );
          if (boat !== null) return yield* new CloudMachineError({ reason: "alias_conflict" });
        }
      });

    const writeHost = (alias: string, endpoint: ManagedSshEndpoint, identityFile?: string) =>
      Effect.gen(function* () {
        if (!options.isAlias(alias) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(alias))
          return yield* failed();
        if (
          [endpoint.host, endpoint.user, identityFile ?? "", endpoint.proxyJump ?? ""].some(
            (value) => /[\r\n\0"]/u.test(value),
          ) ||
          /[\r\n\0]/u.test(endpoint.proxyCommand ?? "") ||
          !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}$/u.test(
            endpoint.hostKey,
          )
        )
          return yield* failed();
        yield* refuseShadowedHost(alias);
        // Check the parent too: chmod must never follow an SSH directory symlink.
        if (yield* isSymlink(sshDir)) return yield* failed();
        yield* ensureDirectory(sshDir).pipe(Effect.mapError(failed));
        yield* ensureCloudDirectory;
        const knownHostsFile = knownHostsPath(alias);
        for (const file of [confPath(alias), knownHostsFile])
          if (yield* isSymlink(file)) return yield* failed();
        const conf = renderCloudHost({
          alias,
          endpoint,
          ...(identityFile === undefined ? {} : { identityFile }),
          knownHostsFile,
        });
        const knownHosts = `${alias} ${endpoint.hostKey}\n`;
        const oldConf = yield* readOptional(confPath(alias)).pipe(Effect.mapError(failed));
        const oldPin = yield* readOptional(knownHostsFile).pipe(Effect.mapError(failed));
        const changed = oldConf !== conf || oldPin !== knownHosts;
        if (options.directory === "goat-hosts" && changed && (oldConf !== null || oldPin !== null))
          return yield* new CloudMachineError({ reason: "alias_conflict" });
        return yield* Effect.gen(function* () {
          yield* writePrivate(knownHostsFile, knownHosts).pipe(Effect.mapError(failed));
          yield* writePrivate(confPath(alias), conf).pipe(Effect.mapError(failed));
          if (options.directory === "goat-hosts") yield* installInclude;
          const output = yield* run("ssh", ["-G", alias]);
          if (
            !effectiveSettingsMatch(output, {
              alias,
              endpoint,
              knownHostsFile,
              ...(identityFile === undefined ? {} : { identityFile }),
            })
          )
            return yield* new CloudMachineError({ reason: "ssh_config_overridden" });
          return { changed };
        }).pipe(
          Effect.onError(() =>
            Effect.all([
              oldConf === null
                ? fs.readFileString(confPath(alias)).pipe(
                    Effect.flatMap((current) =>
                      current === conf ? fs.remove(confPath(alias), { force: true }) : Effect.void,
                    ),
                    Effect.ignore,
                  )
                : Effect.void,
              oldPin === null
                ? fs.readFileString(knownHostsFile).pipe(
                    Effect.flatMap((current) =>
                      current === knownHosts
                        ? fs.remove(knownHostsFile, { force: true })
                        : Effect.void,
                    ),
                    Effect.ignore,
                  )
                : Effect.void,
            ]),
          ),
        );
      });

    const removeHost = (alias: string) =>
      Effect.gen(function* () {
        if (!options.isAlias(alias) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(alias))
          return yield* failed();
        if ((yield* isSymlink(sshDir)) || (yield* isSymlink(cloudDir))) return yield* failed();
        yield* fs.remove(confPath(alias), { force: true }).pipe(Effect.mapError(failed));
        yield* fs.remove(knownHostsPath(alias), { force: true }).pipe(Effect.mapError(failed));
      });

    return { installInclude, ensureKey, writeHost, removeHost };
  });

export const make = (options: { readonly home: string }) =>
  makeManagedSshWriter({
    ...options,
    directory: "goat-cloud",
    isAlias: isCloudMachineAlias,
  }).pipe(
    Effect.map((writer) =>
      CloudMachineSsh.of({
        ...writer,
        writeHost: (alias, endpoint) =>
          writer.writeHost(alias, endpoint, `${options.home}/.ssh/goat-cloud/id_ed25519`),
      }),
    ),
  );

export const layer = (options: { readonly home?: string } = {}) =>
  Layer.effect(CloudMachineSsh, make({ home: options.home ?? NodeOS.homedir() }));
