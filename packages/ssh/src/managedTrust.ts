import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";

/**
 * Trust for hosts GOAT added itself: each alias has a pinned host key under ~/.ssh/goat-hosts, and a
 * connection must match that pin and the pinned ssh configuration. One per manager, which remembers
 * the aliases it has seen managed and the fingerprints it has observed.
 */
export function makeManagedTrust() {
  const managedAliases = new Set<string>();
  const observedPins = new Map<string, string>();
  const managedDirectory = Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* Config.all({
      home: Config.String("HOME").pipe(Config.option),
      profile: Config.String("USERPROFILE").pipe(Config.option),
    });
    const home = Option.getOrUndefined(env.home) ?? Option.getOrUndefined(env.profile);
    return home === undefined ? undefined : path.join(home, ".ssh", "goat-hosts");
  }).pipe(Effect.orElseSucceed(() => undefined));
  const pinError = (changed = false) =>
    new SshCommandError({
      command: ["ssh", "-G"],
      exitCode: null,
      message: changed
        ? "Managed SSH host key changed."
        : "Host key verification failed. Add this host again to review its fingerprint.",
      stderr: changed
        ? "Managed SSH host key changed."
        : "Host key verification failed. Add this host again to review its fingerprint.",
    });
  const readManagedPin = Effect.fn("ssh/tunnel.readManagedPin")(
    function* (target: DesktopSshEnvironmentTarget) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target.alias)) return undefined;
      const directory = yield* managedDirectory;
      if (directory === undefined) return undefined;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const confPath = path.join(directory, `${target.alias}.conf`);
      if (!(yield* fs.exists(confPath))) {
        if (managedAliases.has(target.alias)) return yield* pinError();
        return undefined;
      }
      managedAliases.add(target.alias);
      for (const file of [
        directory,
        confPath,
        path.join(directory, `${target.alias}.known_hosts`),
      ]) {
        const linked = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (linked) return yield* pinError();
      }
      const conf = yield* fs.readFileString(confPath);
      const knownHostsFile = path.join(directory, `${target.alias}.known_hosts`);
      const pin = (yield* fs.readFileString(knownHostsFile)).trim();
      const parts = pin.split(/\s+/u);
      const [, algorithm, key] = parts;
      if (
        parts.length !== 3 ||
        parts[0] !== target.alias ||
        algorithm === undefined ||
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/u.test(algorithm) ||
        key === undefined ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)
      )
        return yield* pinError();
      const stat = yield* fs.stat(confPath);
      const mtime = Option.getOrUndefined(stat.mtime);
      if (mtime === undefined) return yield* pinError();
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", Buffer.from(key, "base64"));
      return {
        alias: target.alias,
        confMtimeMs: mtime.getTime(),
        fingerprint: `SHA256:${Buffer.from(digest).toString("base64").replace(/=+$/u, "")}`,
        conf,
        knownHostsFile,
        algorithm,
      };
    },
    Effect.mapError((error) => (error instanceof SshCommandError ? error : pinError())),
  );
  type ManagedPin = NonNullable<Effect.Success<ReturnType<typeof readManagedPin>>>;
  const samePin = (left: ManagedPin | undefined, right: ManagedPin | undefined) =>
    left === undefined
      ? right === undefined
      : right !== undefined &&
        left.alias === right.alias &&
        left.fingerprint === right.fingerprint &&
        left.confMtimeMs === right.confMtimeMs &&
        left.conf === right.conf;
  const validateManagedPin = Effect.fn("ssh/tunnel.validateManagedPin")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const pin = yield* readManagedPin(target);
    if (pin === undefined) return undefined;
    const output = yield* runSshCommand(target, {
      preHostArgs: ["-G"],
      batchMode: "yes",
      interactiveAuth: false,
    });
    const values = new Map<string, string[]>();
    for (const line of output.stdout.split(/\r?\n/u)) {
      const [name, ...rest] = line.trim().split(/\s+/u);
      if (name)
        values.set(name.toLowerCase(), [...(values.get(name.toLowerCase()) ?? []), rest.join(" ")]);
    }
    const value = (name: string) => values.get(name)?.[0];
    const confValue = (name: string) =>
      new RegExp(`^\\s*${name}\\s+(.+)$`, "imu").exec(pin.conf)?.[1]?.replace(/^"|"$/gu, "");
    const algorithms = pin.algorithm === "ssh-rsa" ? "rsa-sha2-512,rsa-sha2-256" : pin.algorithm;
    if (
      value("hostkeyalias") !== target.alias ||
      value("userknownhostsfile") !== pin.knownHostsFile ||
      value("globalknownhostsfile") !== "/dev/null" ||
      !["yes", "true"].includes(value("stricthostkeychecking") ?? "") ||
      !["no", "false"].includes(value("updatehostkeys") ?? "") ||
      value("hostkeyalgorithms") !== algorithms ||
      (confValue("ProxyJump") !== undefined && value("proxyjump") !== confValue("ProxyJump")) ||
      (confValue("ProxyCommand") !== undefined &&
        value("proxycommand") !== confValue("ProxyCommand")) ||
      value("hostname") !== confValue("HostName") ||
      value("port") !== confValue("Port") ||
      value("user") !== confValue("User") ||
      (confValue("IdentityFile") !== undefined &&
        (value("identityfile") !== confValue("IdentityFile") ||
          !["yes", "true"].includes(value("identitiesonly") ?? "")))
    )
      return yield* pinError();
    const previous = observedPins.get(pin.alias);
    if (previous !== undefined && previous !== pin.fingerprint) return yield* pinError(true);
    observedPins.set(pin.alias, pin.fingerprint);
    return pin;
  });
  return {
    managedAliases,
    observedPins,
    managedDirectory,
    pinError,
    readManagedPin,
    samePin,
    validateManagedPin,
  };
}
