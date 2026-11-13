import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import { sshSettings } from "../penSshRoute.ts";
import {
  disposableKnownHosts,
  disposableSshExecOptions,
  disposableSshTunnelOptions,
} from "./routeContract.ts";

const NODE = "abcdefghijklmnopqrstuvwxyz";
const NOISE = "N".repeat(43);
const PROXY = "/opt/pen pipe --node " + NODE + " --noise " + NOISE + " --home /srv/pen 22";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFcDqbodCFNuBkK2emUwDpZghtdTw4e9ROT+jlVvIhId";
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";

// Everything a person's ssh_config could set to move or loosen the route, or to hand the machine
// owner-local endpoints, environment or credentials, for every pen-* alias.
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
  "    LocalForward 127.0.0.1:9000 127.0.0.1:22",
  "    RemoteForward 127.0.0.1:9001 /tmp/agent.sock",
  "    DynamicForward 9002",
  "    ClearAllForwardings no",
  "    SetEnv EVIL=1",
  "    SendEnv AWS_*",
  "    GSSAPIAuthentication yes",
  "    GSSAPIDelegateCredentials yes",
  "    IdentityFile /tmp/evil_id",
  "    RemoteCommand /bin/sh -c evil",
  "    RequestTTY force",
  "    Tunnel yes",
  "    ForwardX11Trusted yes",
  "    PermitRemoteOpen any",
  "    ConnectTimeout 600",
  "",
].join("\n");
const route = (knownHostsFile: string) => ({
  nodeId: NODE,
  noisePub: NOISE,
  proxyCommand: PROXY,
  user: "runner",
  knownHostsFile,
});
const sshG = (config: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
    runner.run({
      command: "ssh",
      // The person's config comes first, as ~/.ssh/config would; the contract's -F none follows.
      args: ["-G", "-F", config, ...args, "pen-" + NODE],
      timeout: "10 seconds",
    }),
  );

// ssh -G reads the config and the command line without connecting anywhere.
it.live.skipIf(WINDOWS)(
  "nothing in ssh_config changes the run: route, forwards, environment, identities, credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-disposable-route-" });
      yield* fs.writeFileString(dir + "/config", HOSTILE);
      const knownHostsFile = dir + "/pen-" + NODE + ".known_hosts";
      const options = disposableSshExecOptions(route(knownHostsFile));
      expect(options).toBeDefined();
      const printed = yield* sshG(dir + "/config", options ?? []);
      expect(printed.code).toBe(0);
      const settings = sshSettings(printed.stdout);
      const identities = printed.stdout
        .split("\n")
        .filter((line) => line.startsWith("identityfile "));
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
        localforward: settings.get("localforward"),
        remoteforward: settings.get("remoteforward"),
        dynamicforward: settings.get("dynamicforward"),
        clearallforwardings: settings.get("clearallforwardings"),
        setenv: settings.get("setenv"),
        sendenv: settings.get("sendenv"),
        gssapiauthentication: settings.get("gssapiauthentication"),
        gssapidelegatecredentials: settings.get("gssapidelegatecredentials"),
        remotecommand: settings.get("remotecommand"),
        requesttty: settings.get("requesttty"),
        tunnel: settings.get("tunnel"),
        forwardx11trusted: settings.get("forwardx11trusted"),
        permitremoteopen: settings.get("permitremoteopen"),
        connecttimeout: settings.get("connecttimeout"),
        evilIdentity: identities.includes("identityfile /tmp/evil_id"),
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
        localforward: undefined,
        remoteforward: undefined,
        dynamicforward: undefined,
        clearallforwardings: "yes",
        setenv: undefined,
        sendenv: undefined,
        gssapiauthentication: "no",
        gssapidelegatecredentials: "no",
        remotecommand: undefined,
        requesttty: "false",
        tunnel: "false",
        forwardx11trusted: "no",
        permitremoteopen: "none",
        connecttimeout: "10",
        evilIdentity: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.live.skipIf(WINDOWS)(
  "a tunnel carries only the forward its caller names, none from ssh_config",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-disposable-tunnel-" });
      yield* fs.writeFileString(dir + "/config", HOSTILE);
      const options = disposableSshTunnelOptions(route(dir + "/known_hosts"));
      expect(options).toBeDefined();
      const printed = yield* sshG(dir + "/config", [
        ...(options ?? []),
        "-L",
        "127.0.0.1:7000:127.0.0.1:7001",
      ]);
      expect(printed.code).toBe(0);
      const settings = sshSettings(printed.stdout);
      expect({
        localforward: settings.get("localforward"),
        remoteforward: settings.get("remoteforward"),
        dynamicforward: settings.get("dynamicforward"),
        exitonforwardfailure: settings.get("exitonforwardfailure"),
        sendenv: settings.get("sendenv"),
        setenv: settings.get("setenv"),
        user: settings.get("user"),
      }).toEqual({
        localforward: "[127.0.0.1]:7000 [127.0.0.1]:7001",
        remoteforward: undefined,
        dynamicforward: undefined,
        exitonforwardfailure: "yes",
        sendenv: undefined,
        setenv: undefined,
        user: "runner",
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
    const base = route("/s/kh");
    const options = (patch: Partial<typeof base>) =>
      disposableSshExecOptions({ ...base, ...patch });
    expect(options({})).toBeDefined();
    expect(disposableSshTunnelOptions({ ...base, user: "1runner" })).toBeUndefined();
    expect(options({ proxyCommand: "'/opt/pen' pipe %n 22" })).toBeUndefined();
    expect(options({ proxyCommand: PROXY.replace(NODE, "b".repeat(26)) })).toBeUndefined();
    expect(options({ noisePub: "M".repeat(43) })).toBeUndefined();
    // Without --home the pipe would use whatever Pen home the server inherited.
    expect(options({ proxyCommand: PROXY.replace(" --home /srv/pen", "") })).toBeUndefined();
    expect(options({ proxyCommand: "env PEN_HOME='/srv/pen' " + PROXY })).toBeUndefined();
    expect(options({ user: "-oProxyCommand=x" })).toBeUndefined();
    expect(options({ user: "1runner" })).toBeUndefined();
    expect(options({ knownHostsFile: "/s/a b" })).toBeUndefined();
    expect(options({ knownHostsFile: "/s/%d" })).toBeUndefined();
    // ssh expands ${VAR} in UserKnownHostsFile.
    expect(options({ knownHostsFile: "/s/${HOME}/kh" })).toBeUndefined();
    expect(options({ knownHostsFile: "relative" })).toBeUndefined();
  }),
);

// ssh runs ProxyCommand through /bin/sh. A stand-in pen records what it was started with; Pen's own
// test (apps/pen/internal/cli/pipe_test.go) shows --home wins over an inherited PEN_HOME.
it.live.skipIf(WINDOWS)(
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
      const options = disposableSshExecOptions({
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
