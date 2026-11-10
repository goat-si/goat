import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
                const global = input.args.some((arg) => arg.endsWith("/global_known_hosts"));
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

it.effect("a Pen alias's revision changes with the global known_hosts files ssh also reads", () =>
  Effect.gen(function* () {
    const machine = {
      config: PEN_BLOCK("pen-box"),
      sshG: (_: string) => "",
      keys: keyLines("node1", "AAAA1"),
    };
    const { ocx, home } = yield* penHome(machine);
    machine.sshG = penSshG(home);
    const before = yield* ocx.penAliasRevision("pen-box");
    machine.sshG = penSshG(home, { globalknownhostsfile: "/etc/ssh/other_known_hosts" });
    const after = yield* ocx.penAliasRevision("pen-box");
    expect(after).toEqual(expect.any(String));
    expect(after).not.toBe(before);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A key for the alias in a global known_hosts file is one ssh would also accept.
it.effect(
  "a Pen alias that a global known_hosts file also names has no revision, pin or direct route",
  () =>
    Effect.gen(function* () {
      const machine = {
        config: PEN_BLOCK("pen-box"),
        sshG: (_: string) => "",
        keys: keyLines("node1", "AAAA1"),
        fingerprints: FINGERPRINTS,
        globalKeys: "pen-box ssh-ed25519 AAAAOTHER\n",
      };
      const { ocx, home } = yield* penHome(machine);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${home}/global_known_hosts`, "");
      machine.sshG = penSshG(home, {
        globalknownhostsfile: `${home}/global_known_hosts ${home}/missing_known_hosts`,
      });
      expect(yield* ocx.penAliasRevision("pen-box")).toBeUndefined();
      expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
      expect(yield* ocx.directAlias("pen-box")).toBe(false);
      machine.globalKeys = "";
      expect(yield* ocx.penAliasRevision("pen-box")).toEqual(expect.any(String));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
