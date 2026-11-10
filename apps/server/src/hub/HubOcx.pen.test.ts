import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
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
  { name: "a command that only ends in pen", proxy: "'/usr/bin/open' pipe %n 22", direct: false },
])("a Remote Link alias through $name is direct: $direct", ({ proxy, direct }) =>
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    expect(yield* ocx.directAlias("pen-box")).toBe(direct);
  }).pipe(Effect.provide(world(penConfig(proxy)))),
);

it.effect("a Pen alias's pin is the host key Pen recorded for it, of the offered type", () =>
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBe(ED25519);
    expect(yield* ocx.pinnedFingerprint("pen-box", "ECDSA")).toBe(ECDSA);
    expect(yield* ocx.pinnedFingerprint("pen-box", "RSA")).toBeUndefined();
  }).pipe(Effect.provide(world(penConfig("'/home/u/.local/bin/pen' pipe %n 22")))),
);

it.effect("an alias through another ProxyCommand has no Pen pin", () =>
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    expect(yield* ocx.pinnedFingerprint("pen-box", "ED25519")).toBeUndefined();
  }).pipe(Effect.provide(world(penConfig("'/usr/bin/nc' %h %p")))),
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
