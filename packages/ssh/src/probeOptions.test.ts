import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import { readOnlyProxyJumpArgs } from "./probeOptions.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

it.effect.each([
  ["bastion", [{ host: "bastion" }]],
  ["nested", [{ host: "nested" }, { host: "outer" }]],
  ["nested,last", [{ host: "last" }, { host: "nested" }, { host: "outer" }]],
  ["deploy@bastion:2222", [{ host: "bastion", user: "deploy", port: "2222" }]],
  [
    "first,jump@[2001:db8::2]:2200,last",
    [{ host: "last" }, { host: "2001:db8::2", user: "jump", port: "2200" }, { host: "first" }],
  ],
  ["jump'$(false)%h", [{ host: "jump'$(false)%h" }]],
] as const)("protects every child in ProxyJump %s and preserves its argv", ([chain, hops]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-proxy-" });
    const ssh = `${directory}/ssh with 'quotes'`;
    yield* fs.writeFileString(ssh, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    yield* fs.chmod(ssh, 0o700);
    const resolver = lazyChildProcessSpawner((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      expect(command.args).toContain("-G");
      expect(command.args).toContain("PermitLocalCommand=no");
      return Effect.succeed(
        makeSuccessfulProcess(
          command.args.at(-1) === "nested" ? "proxyjump outer\n" : "proxyjump none\n",
        ),
      );
    });
    let proxy = (yield* readOnlyProxyJumpArgs(ssh, new Map([["proxyjump", chain]])).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, resolver),
    ))
      .at(-1)!
      .slice("ProxyCommand=".length);
    for (const hop of hops) {
      // OpenSSH expands tokens before handing ProxyCommand to the shell.
      const expanded = proxy.replace(/%%|%h|%p/gu, (token) =>
        token === "%%" ? "%" : token === "%h" ? "destination.example" : "22",
      );
      const child = yield* runPreflightProcess("/bin/sh", ["-c", expanded]);
      expect(child.exitCode).toBe(0);
      const args = child.stdout.trimEnd().split("\n");
      expect(args.slice(-2)).toEqual(["--", hop.host]);
      expect(args.slice(args.indexOf("-W"), args.indexOf("-W") + 2)).toEqual([
        "-W",
        "[destination.example]:22",
      ]);
      for (const option of [
        "ProxyJump=none",
        "ControlMaster=no",
        "ControlPath=none",
        "BatchMode=yes",
        "UpdateHostKeys=no",
        "PermitLocalCommand=no",
        "ClearAllForwardings=yes",
        "RequestTTY=no",
        "RemoteCommand=none",
        "StrictHostKeyChecking=yes",
        "ForwardAgent=no",
        "ForwardX11=no",
      ])
        expect(args).toContain(option);
      if ("user" in hop)
        expect(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2)).toEqual(["-l", hop.user]);
      if ("port" in hop)
        expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", hop.port]);
      proxy =
        args.find((arg) => arg.startsWith("ProxyCommand="))?.slice("ProxyCommand=".length) ?? "";
      if (proxy === "none") proxy = "";
    }
    expect(proxy).toBe("");
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect.each([undefined, "none"])("keeps custom routing when ProxyJump is %s", (jump) =>
  Effect.gen(function* () {
    expect(yield* readOnlyProxyJumpArgs("ssh", new Map(jump ? [["proxyjump", jump]] : []))).toEqual(
      [],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["loop", "depth", "unresolved"] as const)(
  "rejects %s jump routes before connecting",
  (kind) =>
    Effect.gen(function* () {
      let calls = 0;
      const resolver = lazyChildProcessSpawner(() => {
        calls++;
        return Effect.succeed({
          ...makeSuccessfulProcess(`proxyjump ${kind === "loop" ? "bastion" : `hop-${calls}`}\n`),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(kind === "unresolved" ? 255 : 0)),
        });
      });
      const error = yield* readOnlyProxyJumpArgs("ssh", new Map([["proxyjump", "bastion"]])).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, resolver),
        Effect.flip,
      );
      expect(error._tag).toBe("SshHostKeyProbeError");
      expect(calls).toBe(kind === "depth" ? 8 : 1);
    }),
);
