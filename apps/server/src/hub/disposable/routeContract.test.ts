import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { sshSettings } from "../penSshRoute.ts";
import { disposableKnownHosts, disposableSshOptions } from "./routeContract.ts";

const NODE = "abcdefghijklmnopqrstuvwxyz";
const NOISE = "N".repeat(43);
const PROXY = "/opt/pen pipe --node " + NODE + " --noise " + NOISE + " --home /srv/pen 22";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFcDqbodCFNuBkK2emUwDpZghtdTw4e9ROT+jlVvIhId";

// Everything a person's ssh_config could set to move or loosen the route, for every pen-* alias.
const HOSTILE = [
  "Host pen-*",
  "    User mallory",
  "    Port 2222",
  "    HostName elsewhere.example",
  "    ControlMaster auto",
  "    ControlPath /tmp/goat-cm-%C",
  "    KnownHostsCommand /bin/echo pen-x ssh-ed25519 AAAA",
  "    ProxyJump evil@jump",
  "    HostKeyAlias other",
  "    HostKeyAlgorithms ssh-rsa",
  "    GlobalKnownHostsFile /etc/evil_known_hosts",
  "    UserKnownHostsFile /tmp/evil_known_hosts",
  "    StrictHostKeyChecking no",
  "    UpdateHostKeys yes",
  "    CheckHostIP yes",
  "    ForwardAgent yes",
  "    PermitLocalCommand yes",
  "    LocalCommand id",
  "",
].join("\n");

// ssh -G reads the config and the command line without connecting anywhere.
it.live(
  "ControlMaster, KnownHostsCommand, Port, User or a proxy in ssh_config do not change the run",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-disposable-route-" });
      yield* fs.writeFileString(dir + "/config", HOSTILE);
      const knownHostsFile = dir + "/pen-" + NODE + ".known_hosts";
      const options = disposableSshOptions({
        nodeId: NODE,
        noisePub: NOISE,
        proxyCommand: PROXY,
        user: "runner",
        knownHostsFile,
      });
      expect(options).toBeDefined();
      const runner = yield* ProcessRunner.ProcessRunner;
      const printed = yield* runner.run({
        command: "ssh",
        args: ["-G", "-F", dir + "/config", ...(options ?? []), "pen-" + NODE],
        timeout: "10 seconds",
      });
      expect(printed.code).toBe(0);
      const settings = sshSettings(printed.stdout);
      expect({
        user: settings.get("user"),
        port: settings.get("port"),
        proxycommand: settings.get("proxycommand"),
        proxyjump: settings.get("proxyjump"),
        controlmaster: settings.get("controlmaster"),
        controlpath: settings.get("controlpath"),
        knownhostscommand: settings.get("knownhostscommand"),
        hostkeyalias: settings.get("hostkeyalias"),
        hostkeyalgorithms: settings.get("hostkeyalgorithms"),
        globalknownhostsfile: settings.get("globalknownhostsfile"),
        userknownhostsfile: settings.get("userknownhostsfile"),
        stricthostkeychecking: settings.get("stricthostkeychecking"),
        updatehostkeys: settings.get("updatehostkeys"),
        checkhostip: settings.get("checkhostip"),
        forwardagent: settings.get("forwardagent"),
        permitlocalcommand: settings.get("permitlocalcommand"),
        batchmode: settings.get("batchmode"),
      }).toEqual({
        user: "runner",
        port: "22",
        proxycommand: PROXY,
        // ssh -G leaves out options that are none.
        proxyjump: undefined,
        controlmaster: "false",
        controlpath: undefined,
        knownhostscommand: undefined,
        hostkeyalias: "pen-" + NODE,
        hostkeyalgorithms: "ssh-ed25519",
        globalknownhostsfile: "none",
        userknownhostsfile: knownHostsFile,
        stricthostkeychecking: "true",
        updatehostkeys: "false",
        checkhostip: "no",
        forwardagent: "no",
        permitlocalcommand: "no",
        batchmode: "yes",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect("the private known_hosts names the node's alias and its one recorded key", () =>
  Effect.sync(() => {
    expect(disposableKnownHosts(NODE, KEY)).toBe("pen-" + NODE + " " + KEY + "\n");
    expect(disposableKnownHosts(NODE, "ssh-rsa AAAAB3Nza")).toBeUndefined();
    expect(disposableKnownHosts(NODE, KEY + "\npen-x " + KEY)).toBeUndefined();
    expect(disposableKnownHosts("pen-box", KEY)).toBeUndefined();
  }),
);

it.effect("refuses a route it cannot pass to ssh unchanged", () =>
  Effect.sync(() => {
    const route = {
      nodeId: NODE,
      noisePub: NOISE,
      proxyCommand: PROXY,
      user: "runner",
      knownHostsFile: "/s/kh",
    };
    expect(disposableSshOptions(route)).toBeDefined();
    expect(
      disposableSshOptions({ ...route, proxyCommand: "'/opt/pen' pipe %n 22" }),
    ).toBeUndefined();
    expect(
      disposableSshOptions({ ...route, proxyCommand: PROXY.replace(NODE, "b".repeat(26)) }),
    ).toBeUndefined();
    expect(disposableSshOptions({ ...route, noisePub: "M".repeat(43) })).toBeUndefined();
    // Without --home the pipe would use whatever Pen home the server inherited.
    expect(
      disposableSshOptions({ ...route, proxyCommand: PROXY.replace(" --home /srv/pen", "") }),
    ).toBeUndefined();
    expect(
      disposableSshOptions({ ...route, proxyCommand: "env PEN_HOME='/srv/pen' " + PROXY }),
    ).toBeUndefined();
    expect(disposableSshOptions({ ...route, user: "-oProxyCommand=x" })).toBeUndefined();
    expect(disposableSshOptions({ ...route, user: "1runner" })).toBeUndefined();
    expect(disposableSshOptions({ ...route, knownHostsFile: "/s/a b" })).toBeUndefined();
    expect(disposableSshOptions({ ...route, knownHostsFile: "/s/%d" })).toBeUndefined();
    expect(disposableSshOptions({ ...route, knownHostsFile: "relative" })).toBeUndefined();
  }),
);

// ssh runs ProxyCommand through /bin/sh. A stand-in pen records what it was started with; Pen's own
// test (apps/pen/internal/cli/pipe_test.go) shows --home wins over an inherited PEN_HOME.
it.live(
  "ssh starts the confirmed pen with exactly the route's arguments, whatever PEN_HOME says",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-disposable-run-" });
      const record = dir + "/started";
      yield* fs.writeFileString(
        dir + "/pen",
        '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > \'' + record + "'\nexit 1\n",
      );
      yield* fs.chmod(dir + "/pen", 0o755);
      yield* fs.writeFileString(dir + "/config", HOSTILE);
      const proxyCommand =
        dir + "/pen pipe --node " + NODE + " --noise " + NOISE + " --home " + dir + "/home 22";
      const options = disposableSshOptions({
        nodeId: NODE,
        noisePub: NOISE,
        proxyCommand,
        user: "runner",
        knownHostsFile: dir + "/known_hosts",
      });
      expect(options).toBeDefined();
      const runner = yield* ProcessRunner.ProcessRunner;
      const ran = yield* runner.run({
        command: "ssh",
        args: ["-F", dir + "/config", ...(options ?? []), "pen-" + NODE, "true"],
        env: { ...process.env, PEN_HOME: dir + "/inherited" },
        timeout: "10 seconds",
      });
      // The stand-in exits before any SSH banner, so ssh fails after starting it.
      expect(ran.code).not.toBe(0);
      expect((yield* fs.readFileString(record)).split("\n")).toEqual([
        "pipe",
        "--node",
        NODE,
        "--noise",
        NOISE,
        "--home",
        dir + "/home",
        "22",
        "",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
