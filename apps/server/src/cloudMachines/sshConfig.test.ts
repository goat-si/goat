// @effect-diagnostics nodeBuiltinImport:off - the fake OpenSSH answers synchronously from the files under test.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import type { BoatSshEndpoint } from "./BoatClient.ts";
import * as CloudSsh from "./sshConfig.ts";

const ALIAS = "boat-bx_23456789";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv8eZbJtFiAHk3Fp2Kq";
const endpoint: BoatSshEndpoint = {
  host: "203.0.113.10",
  port: 22,
  user: "user",
  hostKey: HOST_KEY,
};

/**
 * Stands in for OpenSSH. `ssh -G` answers with what the conf GOAT wrote says, unless the test
 * makes an earlier option win; ssh-keygen writes a key pair.
 */
const fakeOpenSsh = (
  home: string,
  options: {
    readonly overridden?: boolean;
    readonly concurrentEdit?: boolean;
    readonly directory?: "goat-cloud" | "goat-hosts";
  } = {},
) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push([input.command, ...input.args]);
        let stdout = "";
        if (input.command === "ssh-keygen") {
          const file = input.args[input.args.indexOf("-f") + 1]!;
          NodeFS.writeFileSync(file, "PRIVATE", { mode: 0o600 });
          NodeFS.writeFileSync(`${file}.pub`, "ssh-ed25519 AAAAGOATKEY goat-cloud\n");
        } else {
          if (options.concurrentEdit)
            NodeFS.appendFileSync(
              NodePath.join(home, ".ssh", "config"),
              "# concurrent user edit\n",
            );
          const conf = NodeFS.readFileSync(
            NodePath.join(home, ".ssh", options.directory ?? "goat-cloud", `${input.args[1]}.conf`),
            "utf8",
          );
          const value = (key: string) =>
            new RegExp(`^\\s*${key} "?([^"\\n]+)"?$`, "mi").exec(conf)?.[1];
          stdout = [
            `hostname ${value("HostName")}`,
            `port ${value("Port")}`,
            `hostkeyalias ${value("HostKeyAlias")}`,
            `stricthostkeychecking ${options.overridden ? "false" : "true"}`,
            `userknownhostsfile ${value("UserKnownHostsFile")}`,
            `globalknownhostsfile ${value("GlobalKnownHostsFile")}`,
            `updatehostkeys ${value("UpdateHostKeys")}`,
            `hostkeyalgorithms ${value("HostKeyAlgorithms")}`,
            `user ${value("User")}`,
            `identityfile ${value("IdentityFile")}`,
            "identityfile ~/.ssh/id_ed25519",
            `identitiesonly ${value("IdentitiesOnly")}`,
          ].join("\n");
        }
        return {
          stdout,
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } as unknown as ProcessRunner.ProcessRunOutput;
      }),
  });
  return { calls, runner };
};

const withSsh = <A, E>(
  options: {
    readonly overridden?: boolean;
    readonly concurrentEdit?: boolean;
    readonly directory?: "goat-cloud" | "goat-hosts";
  },
  use: (
    ssh: CloudSsh.CloudMachineSsh["Service"],
    context: { readonly home: string; readonly calls: Array<ReadonlyArray<string>> },
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cloud-ssh-test-" });
      const openSsh = fakeOpenSsh(home, options);
      const ssh = yield* (
        options.directory === "goat-hosts"
          ? CloudSsh.makeManagedSshWriter({
              home,
              directory: "goat-hosts",
              isAlias: (alias) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias),
            })
          : CloudSsh.make({ home })
      ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, openSsh.runner));
      return yield* use(ssh, { home, calls: openSsh.calls });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const mode = (file: string) => NodeFS.statSync(file).mode & 0o777;

describe("insertCloudInclude", () => {
  it("puts the Include first and leaves every other byte alone", () => {
    const source = "# mine\r\nStrictHostKeyChecking no\r\n\r\nHost box\r\n  User me\r\n";
    const next = CloudSsh.insertCloudInclude(source);
    expect(next).toBe(`${CloudSsh.CLOUD_SSH_INCLUDE}\r\n${source}`);
    expect(CloudSsh.insertCloudInclude(next)).toBe(next);
    expect(CloudSsh.insertCloudInclude("")).toBe(`${CloudSsh.CLOUD_SSH_INCLUDE}\n`);
    const existing = "Host a\n  User b\n  include   ~/.ssh/goat-cloud/*.conf\n";
    expect(CloudSsh.insertCloudInclude(existing)).toBe(existing);
  });
});

describe("CloudMachineSsh", () => {
  it.effect(
    "adds the Include to an existing config once, through a symlink, keeping its mode",
    () =>
      withSsh({}, (ssh, { home }) =>
        Effect.gen(function* () {
          const sshDir = NodePath.join(home, ".ssh");
          NodeFS.mkdirSync(sshDir, { mode: 0o700 });
          const real = NodePath.join(home, "dotfiles-ssh-config");
          NodeFS.writeFileSync(real, "Host box\n  User me\n", { mode: 0o644 });
          NodeFS.symlinkSync(real, NodePath.join(sshDir, "config"));
          yield* ssh.installInclude;
          yield* ssh.installInclude;
          expect(NodeFS.lstatSync(NodePath.join(sshDir, "config")).isSymbolicLink()).toBe(true);
          expect(NodeFS.readFileSync(real, "utf8")).toBe(
            `${CloudSsh.CLOUD_SSH_INCLUDE}\nHost box\n  User me\n`,
          );
          expect(mode(real)).toBe(0o644);
        }),
      ),
  );

  it.effect("creates GOAT's own key once and never completes half a key pair", () =>
    withSsh({}, (ssh, { home, calls }) =>
      Effect.gen(function* () {
        const first = yield* ssh.ensureKey;
        const second = yield* ssh.ensureKey;
        expect(first).toEqual(second);
        expect(first.publicKey).toBe("ssh-ed25519 AAAAGOATKEY goat-cloud");
        expect(calls.filter(([command]) => command === "ssh-keygen")).toHaveLength(1);
        expect(mode(NodePath.join(home, ".ssh", "goat-cloud"))).toBe(0o700);

        NodeFS.rmSync(`${first.identityFile}.pub`);
        const error = yield* ssh.ensureKey.pipe(Effect.flip);
        expect(error.reason).toBe("ssh_config_failed");
        expect(calls.filter(([command]) => command === "ssh-keygen")).toHaveLength(1);
      }),
    ),
  );

  it.effect("writes a private, pinned host pair and reports when the address or key changed", () =>
    withSsh({}, (ssh, { home }) =>
      Effect.gen(function* () {
        const dir = NodePath.join(home, ".ssh", "goat-cloud");
        expect(yield* ssh.writeHost(ALIAS, endpoint)).toEqual({ changed: true });
        expect(yield* ssh.writeHost(ALIAS, endpoint)).toEqual({ changed: false });
        const conf = NodeFS.readFileSync(NodePath.join(dir, `${ALIAS}.conf`), "utf8");
        expect(conf).toContain(`Host ${ALIAS}\n  HostName 203.0.113.10\n  Port 22\n  User user\n`);
        expect(conf).toContain("StrictHostKeyChecking yes");
        expect(conf).toContain(`HostKeyAlias ${ALIAS}`);
        expect(NodeFS.readFileSync(NodePath.join(dir, `${ALIAS}.known_hosts`), "utf8")).toBe(
          `${ALIAS} ${HOST_KEY}\n`,
        );
        expect(mode(NodePath.join(dir, `${ALIAS}.conf`))).toBe(0o600);
        expect(mode(NodePath.join(dir, `${ALIAS}.known_hosts`))).toBe(0o600);

        const moved = { ...endpoint, host: "198.51.100.7", port: 22001 };
        expect(yield* ssh.writeHost(ALIAS, moved)).toEqual({ changed: true });
        expect(NodeFS.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

        yield* ssh.removeHost(ALIAS);
        expect(NodeFS.readdirSync(dir)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a host whose pinned settings an earlier SSH option overrides", () =>
    withSsh({ overridden: true }, (ssh) =>
      Effect.gen(function* () {
        const error = yield* ssh.writeHost(ALIAS, endpoint).pipe(Effect.flip);
        expect(error.reason).toBe("ssh_config_overridden");
      }),
    ),
  );

  it.effect("only writes files for a managed alias", () =>
    withSsh({}, (ssh) =>
      Effect.gen(function* () {
        const error = yield* ssh.writeHost("../../evil", endpoint).pipe(Effect.flip);
        expect(error.reason).toBe("ssh_config_failed");
      }),
    ),
  );
});

describe("CloudMachineSsh refusals", () => {
  it.effect("refuses to shadow a host the user already named", () =>
    withSsh({}, (ssh, { home }) =>
      Effect.gen(function* () {
        NodeFS.mkdirSync(NodePath.join(home, ".ssh"), { mode: 0o700 });
        NodeFS.writeFileSync(
          NodePath.join(home, ".ssh", "config"),
          `Host other ${ALIAS}\n  User me\n`,
        );
        const error = yield* ssh.writeHost(ALIAS, endpoint).pipe(Effect.flip);
        expect(error.reason).toBe("alias_conflict");
        expect(NodeFS.existsSync(NodePath.join(home, ".ssh", "goat-cloud", `${ALIAS}.conf`))).toBe(
          false,
        );
      }),
    ),
  );

  it.effect("refuses a GOAT key that is a link to another identity", () =>
    withSsh({}, (ssh, { home, calls }) =>
      Effect.gen(function* () {
        const dir = NodePath.join(home, ".ssh", "goat-cloud");
        NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(home, "elsewhere"), "PRIVATE");
        NodeFS.writeFileSync(NodePath.join(home, "elsewhere.pub"), "ssh-ed25519 AAAAOTHER other");
        NodeFS.symlinkSync(NodePath.join(home, "elsewhere"), NodePath.join(dir, "id_ed25519"));
        NodeFS.symlinkSync(
          NodePath.join(home, "elsewhere.pub"),
          NodePath.join(dir, "id_ed25519.pub"),
        );
        const error = yield* ssh.ensureKey.pipe(Effect.flip);
        expect(error.reason).toBe("ssh_config_failed");
        expect(calls).toEqual([]);
      }),
    ),
  );
});

describe("managed SSH host writer", () => {
  it.effect("writes pin then conf, preserves user config, and forget removes only its pair", () =>
    withSsh({ directory: "goat-hosts" }, (ssh, { home }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = NodePath.join(home, ".ssh", "goat-hosts");
        NodeFS.mkdirSync(dir, { recursive: true });
        const source = "# user bytes\r\nHost other\r\n  User mine\r\n";
        NodeFS.writeFileSync(NodePath.join(home, ".ssh", "config"), source);
        const key = yield* ssh.ensureKey;
        yield* ssh.writeHost("vps-1", endpoint);
        const conf = yield* fs.readFileString(`${dir}/vps-1.conf`);
        expect(conf).not.toContain("IdentityFile");
        expect(conf).not.toContain("IdentitiesOnly");
        expect(conf).toContain("UpdateHostKeys no");
        expect(conf).toContain("GlobalKnownHostsFile /dev/null");
        expect(yield* ssh.writeHost("vps-1", endpoint)).toEqual({ changed: false });
        expect(
          (yield* ssh.writeHost("vps-1", { ...endpoint, host: "203.0.113.11" }).pipe(Effect.flip))
            .reason,
        ).toBe("alias_conflict");
        const config = NodeFS.readFileSync(NodePath.join(home, ".ssh", "config"), "utf8");
        expect(config).toBe(`Include ~/.ssh/goat-hosts/*.conf\r\n${source}`);
        yield* ssh.writeHost("vps-2", endpoint);
        yield* ssh.removeHost("vps-1");
        expect(NodeFS.existsSync(`${dir}/vps-1.known_hosts`)).toBe(false);
        expect(NodeFS.existsSync(`${dir}/vps-2.conf`)).toBe(true);
        expect(NodeFS.existsSync(key.identityFile)).toBe(true);
        expect(NodeFS.readFileSync(NodePath.join(home, ".ssh", "config"), "utf8")).toBe(config);
      }),
    ),
  );

  it.effect("refuses recursively included user aliases and Boat aliases", () =>
    withSsh({ directory: "goat-hosts" }, (ssh, { home }) =>
      Effect.gen(function* () {
        const dir = NodePath.join(home, ".ssh");
        NodeFS.mkdirSync(`${dir}/parts/nested`, { recursive: true });
        NodeFS.writeFileSync(`${dir}/config`, "Include parts/*.conf\n");
        NodeFS.writeFileSync(`${dir}/parts/one.conf`, "Include parts/nested/*.conf\n");
        NodeFS.writeFileSync(`${dir}/parts/nested/two.conf`, "Host VpS-1 other\n  User mine\n");
        expect((yield* ssh.writeHost("vps-1", endpoint).pipe(Effect.flip)).reason).toBe(
          "alias_conflict",
        );
        NodeFS.mkdirSync(`${dir}/goat-cloud`);
        NodeFS.writeFileSync(`${dir}/goat-cloud/vps-2.conf`, "Host vps-2\n");
        expect((yield* ssh.writeHost("vps-2", endpoint).pipe(Effect.flip)).reason).toBe(
          "alias_conflict",
        );
        expect(NodeFS.existsSync(`${dir}/goat-hosts/vps-1.conf`)).toBe(false);
      }),
    ),
  );

  it.effect(
    "failed validation removes only newly written files, preserving concurrent config edits",
    () =>
      withSsh(
        { directory: "goat-hosts", overridden: true, concurrentEdit: true },
        (ssh, { home }) =>
          Effect.gen(function* () {
            const error = yield* ssh.writeHost("vps-1", endpoint).pipe(Effect.flip);
            expect(error.reason).toBe("ssh_config_overridden");
            const dir = NodePath.join(home, ".ssh");
            expect(NodeFS.existsSync(`${dir}/goat-hosts/vps-1.conf`)).toBe(false);
            expect(NodeFS.existsSync(`${dir}/goat-hosts/vps-1.known_hosts`)).toBe(false);
            expect(NodeFS.readFileSync(`${dir}/config`, "utf8")).toContain(
              "Include ~/.ssh/goat-hosts/*.conf",
            );
            expect(NodeFS.readFileSync(`${dir}/config`, "utf8")).toContain(
              "# concurrent user edit\n",
            );
          }),
      ),
  );
});

const expectedSettings = {
  alias: "vps-1",
  endpoint,
  knownHostsFile: "/home/local/.ssh/goat-hosts/vps-1.known_hosts",
  identityFile: "/home/local/.ssh/id_existing",
};
const effectiveSettings = [
  "hostname 203.0.113.10",
  "port 22",
  "user user",
  "hostkeyalias vps-1",
  "stricthostkeychecking true",
  "updatehostkeys false",
  "globalknownhostsfile /dev/null",
  `userknownhostsfile ${expectedSettings.knownHostsFile}`,
  `identityfile ${expectedSettings.identityFile}`,
  "identitiesonly yes",
  "hostkeyalgorithms ssh-ed25519",
].join("\n");

describe("effective managed SSH settings", () => {
  it("accepts an existing identity or an agent-only target and preserves jump settings", () => {
    expect(CloudSsh.effectiveSettingsMatch(effectiveSettings, expectedSettings)).toBe(true);
    expect(
      CloudSsh.effectiveSettingsMatch(
        effectiveSettings.replace(/^identityfile .*\n|^identitiesonly .*\n/gmu, ""),
        {
          alias: expectedSettings.alias,
          endpoint,
          knownHostsFile: expectedSettings.knownHostsFile,
        },
      ),
    ).toBe(true);
    const jumpEndpoint = { ...endpoint, proxyJump: "trusted-jump", proxyCommand: "none" };
    expect(
      CloudSsh.effectiveSettingsMatch(
        `${effectiveSettings}\nproxyjump trusted-jump\nproxycommand none`,
        { ...expectedSettings, endpoint: jumpEndpoint },
      ),
    ).toBe(true);
    expect(
      CloudSsh.effectiveSettingsMatch(
        `${effectiveSettings}\nproxyjump other-jump\nproxycommand none`,
        { ...expectedSettings, endpoint: jumpEndpoint },
      ),
    ).toBe(false);
  });
  it.each([
    ["user user", "user other"],
    ["hostname 203.0.113.10", "hostname 203.0.113.11"],
    ["updatehostkeys false", "updatehostkeys true"],
    ["globalknownhostsfile /dev/null", "globalknownhostsfile /etc/ssh/ssh_known_hosts"],
    ["stricthostkeychecking true", "stricthostkeychecking accept-new"],
    ["hostkeyalgorithms ssh-ed25519", "hostkeyalgorithms ssh-ed25519,ssh-rsa"],
    [
      `userknownhostsfile ${expectedSettings.knownHostsFile}`,
      `userknownhostsfile ${expectedSettings.knownHostsFile} /home/local/.ssh/known_hosts`,
    ],
  ])("rejects an effective override: %s -> %s", (before, after) => {
    expect(
      CloudSsh.effectiveSettingsMatch(effectiveSettings.replace(before, after), expectedSettings),
    ).toBe(false);
  });
  it("keeps RSA pins on SHA-2 negotiation", () => {
    const conf = CloudSsh.renderCloudHost({
      alias: "vps-1",
      endpoint: { ...endpoint, hostKey: "ssh-rsa AAAA" },
      knownHostsFile: expectedSettings.knownHostsFile,
    });
    expect(conf).toContain("HostKeyAlgorithms rsa-sha2-512,rsa-sha2-256\n");
    expect(conf).not.toContain("HostKeyAlgorithms ssh-rsa");
  });
});
