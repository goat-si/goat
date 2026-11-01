import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@goat/shared/HostProcess";
import { TestClock } from "effect/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

import { probeHostKey } from "./hostKey.ts";
import { makeSuccessfulProcess } from "./tunnel.fixture.ts";

const fingerprint = `SHA256:${"a".repeat(43)}`;
const key = "AAAAC3NzaC1lZDI1NTE5AAAAIJqQutSw0XQo7KOx5R7x4wcb2s6h3WPkcz2z6WIeJ3Re";
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const entered = yield* Deferred.make<void>();
  let hangProbe = false;
  let temporaryFile = "";
  let contents = `[endpoint.example]:2200 ssh-ed25519 ${key}\n`;
  let failFingerprint = false;
  const spawner = lazyChildProcessSpawner((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      calls.push({ command: command.command, args: command.args });
      assert.equal(command.options.forceKillAfter, 2_000);
      if (command.args.includes("-G")) {
        if (command.args.at(-1) === "trusted-jump")
          return makeSuccessfulProcess("proxyjump none\n");
        return makeSuccessfulProcess(
          "hostname endpoint.example\nport 2200\nuser deploy\nproxyjump trusted-jump\nproxycommand none\n",
        );
      }
      if (command.args.includes("-lf")) {
        assert.equal(command.args[command.args.indexOf("-lf") + 1], temporaryFile);
        assert.equal(yield* fs.readFileString(temporaryFile), contents);
        return makeSuccessfulProcess(
          failFingerprint
            ? "not a fingerprint"
            : `256 ${fingerprint} [endpoint.example]:2200 (ED25519)\n`,
        );
      }
      temporaryFile = command.args
        .find((arg) => arg.startsWith("UserKnownHostsFile="))!
        .slice("UserKnownHostsFile=".length)
        .replace(/^"|"$/gu, "");
      assert.equal((yield* fs.stat(temporaryFile)).mode & 0o777, 0o600);
      yield* fs.writeFileString(temporaryFile, contents);
      yield* Deferred.succeed(entered, undefined);
      if (hangProbe) return { ...makeSuccessfulProcess(""), exitCode: Effect.never };
      return {
        ...makeSuccessfulProcess(""),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
        stderr: Stream.make(new TextEncoder().encode("Permission denied (publickey).")),
      };
    }),
  );
  const probe = probeHostKey({ target: "private-alias", user: "deploy", port: 2200 }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return {
    probe,
    calls,
    entered,
    hang: () => {
      hangProbe = true;
    },
    setContents: (value: string) => {
      contents = value;
    },
    failFingerprint: () => {
      failFingerprint = true;
    },
    temporaryFile: () => temporaryFile,
  };
});

describe("negotiated SSH host keys", () => {
  it.effect("bounds a hanging exchange and cleans its temporary known_hosts", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.hang();
      const result = yield* Effect.forkChild(Effect.result(f.probe));
      yield* Deferred.await(f.entered);
      yield* TestClock.adjust("20 seconds");
      const exit = yield* Fiber.join(result);
      assert.equal(exit._tag, "Failure");
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(f.temporaryFile()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses Windows OpenSSH argument arrays with the same isolated trust options", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.probe.pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.equal(f.calls[0]!.command, "ssh.exe");
      assert.equal(f.calls[2]!.command, "ssh.exe");
      assert.equal(f.calls[3]!.command, "ssh-keygen.exe");
      assert.include(f.calls[2]!.args, "GlobalKnownHostsFile=/dev/null");
      const proxy = f.calls[2]!.args.find((arg) => arg.startsWith("ProxyCommand="));
      assert.include(proxy, 'ProxyCommand="ssh.exe"');
      assert.include(proxy, '"UpdateHostKeys=no"');
      assert.include(proxy, '-W "[%h]:%p" -- "trusted-jump"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves alias/jump/user/port and fingerprints only the temporary negotiated key",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        assert.deepEqual(yield* f.probe, { algorithm: "ssh-ed25519", key, fingerprint });
        assert.equal(f.calls.length, 4);
        assert.deepEqual(f.calls[0]!.args, ["-G", "-l", "deploy", "-p", "2200", "private-alias"]);
        const args = f.calls[2]!.args;
        for (const option of [
          "BatchMode=yes",
          "PreferredAuthentications=none",
          "StrictHostKeyChecking=accept-new",
          "UpdateHostKeys=no",
          "PermitLocalCommand=no",
          "GlobalKnownHostsFile=/dev/null",
        ])
          assert.include(args, option);
        assert.deepEqual(args.slice(-3), ["private-alias", "exit", "0"]);
        assert.notInclude(args, "endpoint.example");
        const proxy = args.find((arg) => arg.startsWith("ProxyCommand="));
        assert.include(proxy, "trusted-jump");
        assert.include(proxy, "UpdateHostKeys=no");
        assert.include(proxy, "PermitLocalCommand=no");
        assert.deepEqual(f.calls[3]!.args.slice(0, 3), ["-E", "sha256", "-lf"]);
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(f.temporaryFile()));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    "",
    "# banner\n",
    "endpoint.example ssh-ed25519 AAAA\n",
    `[endpoint.example]:2200 ssh-ed25519 ${key}\n[endpoint.example]:2200 ssh-rsa ${key}\n`,
    `[trusted-jump]:2200 ssh-ed25519 ${key}\n`,
    `[endpoint.example]:2200 ssh-ed25519 ???\n`,
  ])(
    "rejects missing, ambiguous, truncated or wrong-destination key %s and cleans up",
    (contents) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setContents(contents);
        const error = yield* f.probe.pipe(Effect.flip);
        assert.equal(error._tag, "SshHostKeyProbeError");
        const fs = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fs.exists(f.temporaryFile()));
        assert.equal(f.calls.length, 3);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts the single negotiated RSA key without choosing a preferred key type", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setContents(`[endpoint.example]:2200 ssh-rsa ${key}\n`);
      assert.equal((yield* f.probe).algorithm, "ssh-rsa");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects ssh-keygen failure and releases the temporary directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.failFingerprint();
      assert.isTrue(Option.isSome(yield* Effect.option(f.probe.pipe(Effect.flip))));
      const fs = yield* FileSystem.FileSystem;
      assert.isFalse(yield* fs.exists(f.temporaryFile()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
