import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- mkfifo has no Effect equivalent.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { HubOcx, layer as hubOcxLayer } from "./HubOcx.ts";

const ED25519 = "SHA256:" + "E".repeat(43);
const ECDSA = "SHA256:" + "C".repeat(43);

/** `ssh -G` for an alias `pen ssh-config` wrote, as OpenSSH prints it. */
const penConfig = (proxyCommand: string) =>
  [
    "host pen-box",
    "hostname pen-box",
    "user boxes",
    `proxycommand ${proxyCommand}`,
    "userknownhostsfile /home/u/.ssh/pen/known_hosts",
    "stricthostkeychecking true",
  ].join("\n");

const world = (sshG: string) =>
  hubOcxLayer.pipe(
    Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
    Layer.provide(
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.succeed({
            stdout:
              input.args[0] === "-G"
                ? sshG
                : input.args.includes("-F") && input.args.includes("/home/u/.ssh/pen/known_hosts")
                  ? `# Host pen-box found: line 1 \npen-box ECDSA ${ECDSA}\n# Host pen-box found: line 2 \npen-box ED25519 ${ED25519}\n`
                  : "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
    Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
    Layer.provide(Layer.mock(Dispatch.SshRemoteDispatch)({})),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/nonexistent/goat-hub-pen-home")),
    Layer.provide(NodeServices.layer),
  );

// Pen's relay adds one hop of a few seconds, well inside OpenCodex's link admission window.
it.effect.each([
  { name: "Pen's pipe", proxy: "'/home/u/.local/bin/pen' pipe %n 22", direct: true },
  {
    name: "Pen's pipe with its own state directory",
    proxy: "env PEN_HOME='/home/u/pen state' '/opt/pen/bin/pen' pipe %n 22",
    direct: true,
  },
  { name: "another ProxyCommand", proxy: "'/usr/bin/nc' -X 5 -x proxy:1080 %h %p", direct: false },
  {
    name: "a binary whose name only ends in pen",
    proxy: "'/usr/bin/open' pipe %n 22",
    direct: false,
  },
  {
    name: "Pen's pipe followed by a command",
    proxy: "'/home/u/.local/bin/pen' pipe %n 22; id",
    direct: false,
  },
  {
    name: "Pen's pipe with an extra argument",
    proxy: "'/home/u/.local/bin/pen' pipe %n 22 x",
    direct: false,
  },
  {
    name: "Pen's pipe under another variable",
    proxy: "env LD_PRELOAD='/tmp/x.so' '/home/u/.local/bin/pen' pipe %n 22",
    direct: false,
  },
])("a Pen member's alias through $name is direct: $direct", ({ proxy, direct }) =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home, { proxycommand: proxy });
    expect(yield* ocx.directAlias("pen-box")).toBe(direct);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Only Pen's own files make a proxied alias direct; the ProxyCommand alone does not.
it.effect("a Pen-shaped ProxyCommand without Pen's files is not direct", () =>
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    expect(yield* ocx.directAlias("pen-box")).toBe(false);
  }).pipe(Effect.provide(world(penConfig("'/home/u/.local/bin/pen' pipe %n 22")))),
);

const sleepingDevice = (failure: Dispatch.SshRemoteDispatchError | undefined) =>
  hubOcxLayer.pipe(
    Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
    Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
    Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
    Layer.provide(
      Layer.mock(Dispatch.SshRemoteDispatch)({
        runHostScript: () =>
          failure === undefined
            ? Effect.succeed({ stdout: "\n__goat_ocx_exit=0\n", stderr: "" })
            : Effect.fail(failure),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

// A Pen box that went to sleep: its relay pipe closes before SSH's banner.
it.effect("a device SSH cannot reach is unreachable, not a device that answers no shell", () =>
  Effect.gen(function* () {
    const asleep = new Dispatch.SshRemoteDispatchError({
      reason: "ssh_failed",
      message:
        "SSH to pen-box failed: kex_exchange_identification: Connection closed by remote host\r\nConnection closed by UNKNOWN port 65535",
    });
    const unreachable = yield* HubOcx.pipe(
      Effect.flatMap((ocx) => ocx.devicePlatform("pen-box")),
      Effect.provide(sleepingDevice(asleep)),
    );
    expect(unreachable).toBe("unreachable");
    const silent = yield* HubOcx.pipe(
      Effect.flatMap((ocx) => ocx.devicePlatform("pen-box")),
      Effect.provide(sleepingDevice(undefined)),
    );
    expect(silent).toBeUndefined();
  }),
);

/** A hub whose ~/.ssh/pen is a scratch directory; ssh -G and ssh-keygen answer from `machine`. */
const penHome = Effect.fn("HubOcxPenTest.penHome")(function* (machine: {
  config: string;
  sshG: (alias: string) => string;
  keys: string;
  fingerprints?: string;
  failSshG?: boolean;
  /** Lines a global known_hosts file holds for the alias. */
  globalKeys?: string;
  /** Paths that exist besides the scratch home, such as ssh's global known_hosts. */
  existing?: ReadonlyArray<string>;
  /** How a stat of Pen's config behaves: it never answers, or reports a FIFO. */
  configStat?: "stalls" | "fifo" | "regular";
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-hub-pen-" });
  yield* fs.makeDirectory(`${home}/.ssh/pen`, { recursive: true });
  const write = (config: string) => fs.writeFileString(`${home}/.ssh/pen/config`, config);
  yield* write(machine.config);
  const ocx = yield* HubOcx.pipe(
    Effect.provide(
      hubOcxLayer.pipe(
        Layer.provide(Layer.mock(HostThreads.HostThreadsMcpService)({})),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (input) =>
              Effect.sync(() => {
                const global = input.args.some((arg) => arg.startsWith("/etc/ssh/"));
                const stdout =
                  input.args[0] === "-G"
                    ? machine.sshG(input.args[1] ?? "")
                    : input.args.includes(`${home}/.ssh/pen/known_hosts`)
                      ? input.args.includes("-l")
                        ? (machine.fingerprints ?? "")
                        : machine.keys
                      : global
                        ? (machine.globalKeys ?? "")
                        : "";
                // ssh-keygen -F exits 1 when the file holds no key for the host.
                const code =
                  input.args[0] === "-G"
                    ? machine.failSshG === true
                      ? 255
                      : 0
                    : stdout === ""
                      ? 1
                      : 0;
                return {
                  stdout,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(code),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        ),
        Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
        Layer.provide(Layer.mock(Dispatch.SshRemoteDispatch)({})),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
        Layer.provide(
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (real) => ({
              ...real,
              exists: (path: string) =>
                machine.existing?.includes(path) === true
                  ? Effect.succeed(true)
                  : real.exists(path),
              stat: (path: string) =>
                !path.endsWith("/.ssh/pen/config") || machine.configStat === undefined
                  ? real.stat(path)
                  : machine.configStat === "stalls"
                    ? Effect.never
                    : machine.configStat === "regular"
                      ? Effect.map(real.stat(`${path}.regular`), (info) => ({ ...info }))
                      : Effect.map(real.stat(path), (info) => ({ ...info, type: "FIFO" as const })),
            })),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { ocx, home, write };
});

const PEN_BLOCK = (alias: string) =>
  `Host ${alias}\n    User boxes\n    ProxyCommand '/home/u/.local/bin/pen' pipe %n 22\n`;
const penSshG =
  (home: string, overrides: Record<string, string> = {}) =>
  (alias: string) =>
    Object.entries({
      hostname: alias,
      user: "boxes",
      port: "22",
      proxycommand: "'/home/u/.local/bin/pen' pipe %n 22",
      userknownhostsfile: `${home}/.ssh/pen/known_hosts`,
      stricthostkeychecking: "true",
      globalknownhostsfile: "/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
      ...overrides,
    })
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
const keyLines = (node: string, key: string) =>
  `# Host pen-box found: line 1 \npen-box,pen-${node} ssh-ed25519 ${key}\n`;

it.effect(
  "a Pen member's alias has a consent revision; a Pen alias with no recorded key has none",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
      };
      const { ocx, home } = yield* penHome(machine);
      machine.sshG = penSshG(home);
      expect(yield* ocx.penAliasRevision("pen-box")).toEqual(expect.any(String));
      machine.keys = "";
      expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a Pen alias's revision changes with its host key, its node and its effective SSH settings",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
      };
      const { ocx, home } = yield* penHome(machine);
      machine.sshG = penSshG(home);
      const first = yield* ocx.penAliasRevision("pen-box");
      const seen = new Set([first]);
      const changed = function* (label: string) {
        const next = yield* ocx.penAliasRevision("pen-box");
        expect(next, label).toEqual(expect.any(String));
        expect(seen.has(next), label).toBe(false);
        seen.add(next);
      };
      machine.keys = keyLines("node1", "AAAA2");
      yield* changed("host key");
      // A machine that joins later under the same name is another member.
      machine.keys = keyLines("node2", "AAAA2");
      yield* changed("node");
      machine.sshG = penSshG(home, { user: "root" });
      yield* changed("User");
      machine.sshG = penSshG(home, {
        proxycommand: "env PEN_HOME='/tmp/x' '/home/u/.local/bin/pen' pipe %n 22",
      });
      yield* changed("ProxyCommand");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a revoked member, or an alias Pen did not write, has no revision", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
    };
    const { ocx, home, write } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.penAliasRevision("pen-box")).toEqual(expect.any(String));
    // Another known_hosts file means ssh would not check Pen's recorded key.
    machine.sshG = penSshG(home, { userknownhostsfile: "/home/u/.ssh/known_hosts" });
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    machine.sshG = penSshG(home, { proxycommand: "'/usr/bin/nc' %h %p" });
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    machine.sshG = penSshG(home);
    // A hand-made Host pen-foo outside Pen's config, routed and keyed like Pen's, is still not Pen's.
    expect(yield* ocx.penAliasRevision("pen-foo")).toBeUndefined();
    // Revoked or left: Pen rewrites its config without the member's Host block.
    yield* write("Host pen-*\n    ProxyCommand '/home/u/.local/bin/pen' pipe %n 22\n");
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const FINGERPRINTS = `# Host pen-box found: line 1 \npen-box ECDSA ${ECDSA}\n# Host pen-box found: line 2 \npen-box ED25519 ${ED25519}\n`;

it.effect("a Pen member's pin is the host key Pen recorded for it, of the offered type", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBe(ED25519);
    expect(yield* ocx.pinnedFingerprint("pen-box", "ECDSA")).toBe(ECDSA);
    expect(yield* ocx.pinnedFingerprint("pen-box", "RSA")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Pen is recognized by its own files, never by the name: without them a pen-* alias is any alias.
it.effect("a pin comes only from Pen's own ssh config and known_hosts", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home, write } = yield* penHome(machine);
    machine.sshG = penSshG(home, { userknownhostsfile: "/home/u/.ssh/other_known_hosts" });
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    machine.sshG = penSshG(home, { proxycommand: "'/usr/bin/nc' %h %p" });
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    machine.sshG = penSshG(home);
    expect(yield* ocx.pinnedFingerprint("pen-foo", "ED25519")).toBeUndefined();
    yield* write("");
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh checks the key under HostKeyAlias or HostName, so Pen's record for the alias would not be it.
it.effect("a Pen alias whose key ssh looks up under another name has no revision and no pin", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    for (const overrides of [{ hostkeyalias: "other" }, { hostname: "10.0.0.5" }]) {
      machine.sshG = penSshG(home, overrides);
      expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
      expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A failed read proves nothing about the member, so it must not read as "another member".
it.effect("a Pen alias whose settings cannot be read fails instead of answering no revision", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      failSshG: true,
    };
    const { ocx } = yield* penHome(machine);
    const failed = yield* ocx.penAliasRevision("pen-box").pipe(Effect.flip);
    expect(failed._tag).toBe("HubOcxError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("two recorded keys of the offered type name no pin", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: `pen-box ED25519 ${ED25519}\npen-box ED25519 ${ECDSA}\n`,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh's own host-key policy is part of what the pin and consent stand for.
it.effect(
  "a Pen alias that ssh would not hold to Pen's key strictly has no revision and no pin",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
        fingerprints: FINGERPRINTS,
      };
      const { ocx, home } = yield* penHome(machine);
      for (const overrides of [
        { stricthostkeychecking: "ask" },
        { stricthostkeychecking: "false" },
        { stricthostkeychecking: "accept-new" },
        { knownhostscommand: "/usr/local/bin/hostkeys %H" },
      ]) {
        machine.sshG = penSshG(home, overrides);
        expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
        expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
        expect(yield* ocx.directAlias("pen-box")).toBe(false);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh -G prints GlobalKnownHostsFile unquoted, so only settings whose files are certain count.
it.effect("a Pen alias is trusted only under ssh's default global known_hosts files or none", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    for (const globalknownhostsfile of [
      "known_hosts.global",
      "/etc/ssh/ssh_known_hosts",
      "/etc/ssh/ssh_known_hosts  /etc/ssh/ssh_known_hosts2",
      "/tmp/a /tmp/b /tmp/c",
      `${home}/my keys/known_hosts`,
    ]) {
      machine.sshG = penSshG(home, { globalknownhostsfile });
      expect(yield* ocx.penAliasRevision("pen-box"), globalknownhostsfile).toBeUndefined();
      expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
      expect(yield* ocx.directAlias("pen-box")).toBe(false);
    }
    machine.sshG = penSshG(home);
    const standard = yield* ocx.penAliasRevision("pen-box");
    machine.sshG = penSshG(home, { globalknownhostsfile: "none" });
    const none = yield* ocx.penAliasRevision("pen-box");
    expect(standard).toEqual(expect.any(String));
    expect(none).toEqual(expect.any(String));
    expect(none).not.toBe(standard);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A key for the alias in ssh's own global known_hosts is one ssh would also accept.
it.effect(
  "a Pen alias that ssh's global known_hosts also names has no revision, pin or direct route",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
        fingerprints: FINGERPRINTS,
        globalKeys: "pen-box ssh-ed25519 AAAAOTHER\n",
        existing: ["/etc/ssh/ssh_known_hosts2"],
      };
      const { ocx, home } = yield* penHome(machine);
      machine.sshG = penSshG(home);
      expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
      expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
      expect(yield* ocx.directAlias("pen-box")).toBe(false);
      machine.globalKeys = "";
      expect(yield* ocx.penAliasRevision("pen-box")).toEqual(expect.any(String));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh -G prints GlobalKnownHostsFile="/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2" like the
// default pair, so when a file of that one name exists the setting is ambiguous.
it.effect(
  "a Pen alias is not trusted when the default global setting could name one spaced file",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
        fingerprints: FINGERPRINTS,
        existing: ["/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2"],
      };
      const { ocx, home } = yield* penHome(machine);
      machine.sshG = penSshG(home);
      expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
      expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
      expect(yield* ocx.directAlias("pen-box")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// On another port ssh checks the key under [alias]:port, not the entry Pen recorded for the alias.
it.effect("a Pen alias on a port other than 22 has no revision, pin or direct route", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home, { port: "2222" });
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    expect(yield* ocx.directAlias("pen-box")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The server holds every buffer to a limit, and no single read may hang it.
it.effect("a Pen config above 64 KiB stays usable; one above the cap says so", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box") + "#".repeat(70 * 1024),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home, write } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.penAliasRevision("pen-box")).toEqual(expect.any(String));
    expect(yield* ocx.directAlias("pen-box")).toBe(true);
    yield* write(PEN_BLOCK("pen-box") + "#".repeat(5 * 1024 * 1024));
    const failed = yield* ocx.penAliasRevision("pen-box").pipe(Effect.flip);
    expect(failed.message).toContain("larger than");
    expect((yield* ocx.directAlias("pen-box").pipe(Effect.flip)).message).toContain("larger than");
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a Pen config that is not a regular file is a failed read and is never opened", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      configStat: "fifo" as const,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect((yield* ocx.penAliasRevision("pen-box").pipe(Effect.flip))._tag).toBe("HubOcxError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a read of Pen's config that never finishes fails after its deadline", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      configStat: "stalls" as const,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    const read = yield* ocx.penAliasRevision("pen-box").pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    expect((yield* Fiber.join(read))._tag).toBe("HubOcxError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh trusts certificates a @cert-authority line names, which Pen never writes.
it.effect("a Pen alias with a marker line in Pen's known_hosts is not trusted", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys:
        keyLines("node1", "AAAA1") +
        "# Host pen-box found: line 2 CA\n@cert-authority pen-box ssh-ed25519 AAAACA\n",
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    expect(yield* ocx.directAlias("pen-box")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a Pen alias with a @revoked line in Pen's known_hosts is not trusted", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys:
        keyLines("node1", "AAAA1") +
        "# Host pen-box found: line 2 REVOKED\n@revoked pen-box ssh-ed25519 AAAAOLD\n",
      fingerprints: FINGERPRINTS,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
    expect(yield* ocx.directAlias("pen-box")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Opening a FIFO for reading waits for a writer; the open must not, whatever the first stat said.
// Windows has no FIFOs; there the open passes O_RDONLY | 0, since O_NONBLOCK is absent.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a Pen config that turns into a FIFO after its stat fails at once",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
        configStat: "regular" as const,
      };
      const { ocx, home } = yield* penHome(machine);
      machine.sshG = penSshG(home);
      const config = `${home}/.ssh/pen/config`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.rename(config, `${config}.regular`);
      NodeChildProcess.execFileSync("mkfifo", [config]);
      expect((yield* ocx.penAliasRevision("pen-box").pipe(Effect.flip))._tag).toBe("HubOcxError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A status pass reads every host in turn; one stalled config read must not cost a deadline each.
it.effect("aliases read in turn share one deadline when Pen's config never answers", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
      configStat: "stalls" as const,
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    const pass = yield* Effect.forEach(["pen-a", "pen-b", "pen-c", "pen-d", "pen-e"], (alias) =>
      ocx.penAliasRevision(alias).pipe(Effect.flip),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    const failures = yield* Fiber.join(pass);
    expect(failures.map((failure) => failure._tag)).toEqual(Array(5).fill("HubOcxError"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const EXACT_NODE = "abcdefghijklmnopqrstuvwxyz";
const EXACT_NOISE = "N".repeat(43);
const EXACT_ALIAS = "pen-" + EXACT_NODE;
const EXACT_PROXY =
  "'/home/u/.local/bin/pen' pipe --node " + EXACT_NODE + " --noise " + EXACT_NOISE + " 22";
const EXACT_BLOCK =
  "Host " + EXACT_ALIAS + "\n    User runner\n    ProxyCommand " + EXACT_PROXY + "\n";
const ED_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIFcDqbodCFNuBkK2emUwDpZghtdTw4e9ROT+jlVvIhId";
const exactKeys = (...lines: ReadonlyArray<string>) =>
  lines
    .map(
      (line, index) =>
        "# Host " + EXACT_ALIAS + " found: line " + (index + 1) + " \n" + line + "\n",
    )
    .join("");
const exactMachine = Effect.fn("HubOcxPenTest.exactMachine")(function* (
  config: string,
  proxy: string,
) {
  const machine = {
    config,
    sshG: (_: string) => "",
    keys: exactKeys(
      "pen-box," + EXACT_ALIAS + " ssh-ed25519 " + ED_KEY,
      "pen-box," + EXACT_ALIAS + " ecdsa-sha2-nistp256 AAAAE2VjZHNh",
    ),
  };
  const { ocx, home } = yield* penHome(machine);
  machine.sshG = penSshG(home, { proxycommand: proxy, user: "runner" });
  const pen = { executablePath: "/home/u/.local/bin/pen", stateDir: home + "/.pen" };
  return { ocx, machine, home, pen, node: { nodeId: EXACT_NODE, noisePub: EXACT_NOISE } };
});

it.effect("Pen's exact block for a node is a route only with the Noise key GOAT recorded", () =>
  Effect.gen(function* () {
    const { ocx, pen, node } = yield* exactMachine(PEN_BLOCK("pen-box") + EXACT_BLOCK, EXACT_PROXY);
    expect(yield* ocx.penExactRoute(node, pen)).toEqual({
      kind: "route",
      alias: EXACT_ALIAS,
      // Whatever form Pen wrote, GOAT runs the confirmed pen with its home, unquoted.
      proxyCommand:
        "/home/u/.local/bin/pen pipe --node " +
        EXACT_NODE +
        " --noise " +
        EXACT_NOISE +
        " --home " +
        pen.stateDir +
        " 22",
      user: "runner",
      hostKey: "ssh-ed25519 " + ED_KEY,
      fingerprint: "SHA256:nz9cVTpQx8PimslFh9CITEcWGb7QKBXpUlHyEaSApSw",
    });
    expect(yield* ocx.penExactRoute({ ...node, noisePub: "M".repeat(43) }, pen)).toEqual({
      kind: "refused",
      reason: "no_exact_block",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Pen gives an id another member uses as a name only that member's name block.
it.effect("a node id another member uses as its name stays refused", () =>
  Effect.gen(function* () {
    const { ocx, pen, node } = yield* exactMachine(
      PEN_BLOCK(EXACT_ALIAS),
      "'/home/u/.local/bin/pen' pipe %n 22",
    );
    expect(yield* ocx.penExactRoute(node, pen)).toEqual({
      kind: "refused",
      reason: "no_exact_block",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an exact block with two ed25519 keys, none, or no User of Pen's names no route", () =>
  Effect.gen(function* () {
    const { ocx, machine, pen, node } = yield* exactMachine(
      PEN_BLOCK("pen-box") + EXACT_BLOCK,
      EXACT_PROXY,
    );
    const read = ocx.penExactRoute(node, pen);
    machine.keys = exactKeys(
      "pen-box," + EXACT_ALIAS + " ssh-ed25519 " + ED_KEY,
      EXACT_ALIAS + ",pen-other ssh-ed25519 " + ED_KEY.replace("IFc", "IGc"),
    );
    expect(yield* read).toEqual({ kind: "refused", reason: "several_keys" });
    machine.keys = exactKeys("pen-box," + EXACT_ALIAS + " ecdsa-sha2-nistp256 AAAAE2VjZHNh");
    expect(yield* read).toEqual({ kind: "refused", reason: "no_key" });
    machine.keys = exactKeys("pen-box," + EXACT_ALIAS + " ssh-ed25519 " + ED_KEY);
    machine.config = PEN_BLOCK("pen-box") + EXACT_BLOCK.replace("    User runner\n", "");
    const withoutUser = yield* exactMachine(machine.config, EXACT_PROXY);
    expect(yield* withoutUser.ocx.penExactRoute(node, withoutUser.pen)).toEqual({
      kind: "refused",
      reason: "no_user",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ssh keeps the first value it reads, so an entry above Pen's Include wins over Pen's block.
it.effect("an exact route run by any pen or Pen home but the confirmed one is refused", () =>
  Effect.gen(function* () {
    const other = EXACT_PROXY.replace("/home/u/.local/bin/pen", "/tmp/x/pen");
    const overridden = yield* exactMachine(PEN_BLOCK("pen-box") + EXACT_BLOCK, other);
    expect(yield* overridden.ocx.penExactRoute(overridden.node, overridden.pen)).toEqual({
      kind: "refused",
      reason: "other_pen",
    });
    const ownHome = "env PEN_HOME='/tmp/other' " + EXACT_PROXY;
    const otherHome = yield* exactMachine(
      PEN_BLOCK("pen-box") + EXACT_BLOCK.replace(EXACT_PROXY, ownHome),
      ownHome,
    );
    expect(yield* otherHome.ocx.penExactRoute(otherHome.node, otherHome.pen)).toEqual({
      kind: "refused",
      reason: "other_pen",
    });
    // The same pen under the confirmed state folder, named explicitly, is that Pen.
    const confirmed = yield* exactMachine(PEN_BLOCK("pen-box") + EXACT_BLOCK, EXACT_PROXY);
    const named = "env PEN_HOME='" + confirmed.pen.stateDir + "' " + EXACT_PROXY;
    const explicit = yield* exactMachine(
      PEN_BLOCK("pen-box") + EXACT_BLOCK.replace(EXACT_PROXY, named),
      named,
    );
    const route = yield* explicit.ocx.penExactRoute(explicit.node, {
      ...explicit.pen,
      stateDir: confirmed.pen.stateDir,
    });
    expect(route).toMatchObject({ kind: "route" });
    // A confirmed Pen home that needs quoting has no route OpenCodex could take.
    const spaced = { ...explicit.pen, stateDir: confirmed.pen.stateDir + " x" };
    const quoted = "env PEN_HOME='" + spaced.stateDir + "' " + EXACT_PROXY;
    const unsafe = yield* exactMachine(
      PEN_BLOCK("pen-box") + EXACT_BLOCK.replace(EXACT_PROXY, quoted),
      quoted,
    );
    expect(yield* unsafe.ocx.penExactRoute(unsafe.node, spaced)).toEqual({
      kind: "refused",
      reason: "unsafe_pen_path",
    });
    // A confirmed Pen installed under another name is still that Pen.
    const renamed = EXACT_PROXY.replace("/home/u/.local/bin/pen", "/opt/bin/pen-v1");
    const renamedPen = yield* exactMachine(
      PEN_BLOCK("pen-box") + EXACT_BLOCK.replace(EXACT_PROXY, renamed),
      renamed,
    );
    expect(
      yield* renamedPen.ocx.penExactRoute(renamedPen.node, {
        ...renamedPen.pen,
        executablePath: "/opt/bin/pen-v1",
      }),
    ).toMatchObject({ kind: "route" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
