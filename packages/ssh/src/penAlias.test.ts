import * as NodeServices from "@effect/platform-node/NodeServices";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";
import { inspectPenExactAlias } from "./penAlias.ts";

const node = "a".repeat(26);
const alias = `pen-${node}`;
const noise = "A".repeat(43);

it.effect.each([
  "trusted",
  "global",
  "marker",
  "ssh-fails",
  "no-key",
  "keygen-fails",
  "truncated",
] as const)("inspects %s alias", (mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = `${home}/.ssh/pen`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/config`, `Host ${alias}\n`);
    const global = "/etc/ssh/ssh_known_hosts";
    const settings = `hostname ${alias}\nuser bob\nport 22\nproxycommand '/bin/pen' pipe --node ${node} --noise ${noise} 22\nproxyjump none\nstricthostkeychecking true\ncontrolmaster false\ncontrolpath none\nuserknownhostsfile ${dir}/known_hosts\nglobalknownhostsfile ${mode === "global" ? `${global} /etc/ssh/ssh_known_hosts2` : "none"}\n`;
    const spawner = lazyChildProcessSpawner((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("pipeline");
      const isSsh = command.command === "fake-ssh";
      const output =
        mode === "truncated"
          ? "x".repeat(65536)
          : isSsh
            ? settings
            : mode === "marker"
              ? "@revoked host key"
              : `${alias} ssh-ed25519 AAA`;
      const exit =
        (isSsh && mode === "ssh-fails") || (!isSsh && mode === "no-key")
          ? 1
          : !isSsh && mode === "keygen-fails"
            ? 2
            : 0;
      return Effect.succeed({
        ...makeSuccessfulProcess(output),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
      });
    });
    const fakeFs =
      mode === "global"
        ? {
            ...fs,
            exists: (file: string) => (file === global ? Effect.succeed(true) : fs.exists(file)),
          }
        : fs;
    const result = yield* inspectPenExactAlias({
      alias,
      homeDirectory: home,
      sshCommand: "fake-ssh",
      sshKeygenCommand: "fake-keygen",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fakeFs),
      Effect.result,
    );
    if (mode === "ssh-fails" || mode === "keygen-fails" || mode === "truncated")
      expect(result._tag).toBe("Failure");
    else if (result._tag === "Success") {
      if (mode === "trusted")
        expect(result.success).toMatchObject({
          alias,
          nodeId: node,
          target: { alias, hostname: alias, username: "bob", port: null },
        });
      if (mode === "global") expect(result.success).toEqual({ refused: "global-known-hosts" });
      if (mode === "marker") expect(result.success).toEqual({ refused: "marker-lines" });
      if (mode === "no-key") expect(result.success).toEqual({ refused: "no-recorded-key" });
    } else expect.fail("expected successful inspection");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a command timeout as unreadable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const dir = `${home}/.ssh/pen`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/config`, `Host ${alias}\n`);
    const started = yield* Deferred.make<void>();
    const spawner = lazyChildProcessSpawner(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return { ...makeSuccessfulProcess(""), exitCode: Effect.never };
      }),
    );
    const fiber = yield* inspectPenExactAlias({ alias, homeDirectory: home }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(fiber))._tag).toBe("PenAliasUnreadable");
  }).pipe(Effect.provide(NodeServices.layer)),
);
