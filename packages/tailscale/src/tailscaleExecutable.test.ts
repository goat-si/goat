import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
} from "./tailscale.ts";

const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const LAUNCHER_CLI = "/usr/local/bin/tailscale";
const HOMEBREW_CLI = "/opt/homebrew/bin/tailscale";
const statusJson = '{"Self":{"DNSName":"mac.tail.ts.net.","TailscaleIPs":["100.100.100.1"]}}';

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined> | undefined;
  readonly extendEnv: boolean | undefined;
}

const encoder = new TextEncoder();

function handle(stdout: string, hang: boolean) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: hang ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const spawnError = (tag: "NotFound" | "PermissionDenied", command: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: command,
  });

/**
 * A host whose PATH has no `tailscale` unless `onPath` says so, and whose
 * filesystem holds exactly `installed`. Independent of the machine running
 * the test, so a developer's own wrapper on PATH cannot make it pass.
 */
function layerHost(input: {
  readonly platform: NodeJS.Platform;
  readonly onPath?: boolean;
  readonly installed?: ReadonlyArray<string>;
  readonly denied?: ReadonlyArray<string>;
  readonly hang?: boolean;
  readonly spawned: Array<Spawned>;
}) {
  return Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") {
          return Effect.die("unexpected piped command");
        }
        input.spawned.push({
          command: command.command,
          args: command.args,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
        });
        if (input.denied?.includes(command.command)) {
          return Effect.fail(spawnError("PermissionDenied", command.command));
        }
        const found = command.command.startsWith("/")
          ? (input.installed ?? []).includes(command.command)
          : input.onPath === true;
        return found
          ? Effect.succeed(handle(statusJson, input.hang === true))
          : Effect.fail(spawnError("NotFound", command.command));
      }),
    ),
    Layer.succeed(HostProcess.Platform, input.platform),
  );
}

describe("tailscale executable on macOS", () => {
  // regression: Tailscale.app puts no CLI on PATH, so every status read failed
  // with spawn ENOENT and Settings hid the Tailscale HTTPS switch.
  it.effect(
    "reads status and prefs and configures serve through the app CLI when PATH has none",
    () => {
      const spawned: Array<Spawned> = [];
      const layer = layerHost({ platform: "darwin", installed: [APP_CLI], spawned });

      return Effect.gen(function* () {
        const status = yield* readTailscaleStatus;
        assert.equal(status.magicDnsName, "mac.tail.ts.net");
        yield* readTailscaleSshEnabled;
        yield* ensureTailscaleServe({ localPort: 13773 });
        yield* disableTailscaleServe();

        const ran = spawned.filter((entry) => entry.command === APP_CLI);
        assert.deepEqual(
          ran.map((entry) => entry.args[0]),
          ["status", "debug", "serve", "serve"],
        );
        for (const entry of ran) {
          assert.equal(entry.env?.["TAILSCALE_BE_CLI"], "1");
          assert.isTrue(entry.extendEnv);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("prefers a tailscale on PATH and leaves its environment alone", () => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({ platform: "darwin", onPath: true, installed: [APP_CLI], spawned });

    return Effect.gen(function* () {
      yield* readTailscaleStatus;
      assert.deepEqual(
        spawned.map((entry) => [entry.command, entry.env]),
        [["tailscale", undefined]],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { installed: [LAUNCHER_CLI, HOMEBREW_CLI, APP_CLI], expected: [LAUNCHER_CLI] },
    { installed: [HOMEBREW_CLI, APP_CLI], expected: [LAUNCHER_CLI, HOMEBREW_CLI] },
  ])("uses the first installed CLI of the launcher, Homebrew, then the app", (input) => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({ platform: "darwin", installed: input.installed, spawned });

    return Effect.gen(function* () {
      yield* readTailscaleStatus;
      assert.deepEqual(
        spawned.map((entry) => entry.command),
        ["tailscale", ...input.expected],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the original not-found failure when no CLI is installed", () => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({ platform: "darwin", spawned });

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip);
      assert.instanceOf(error, TailscaleCommandSpawnError);
      assert.equal(error.executable, "tailscale");
      assert.include(String((error as TailscaleCommandSpawnError).cause), "NotFound");
      assert.deepEqual(
        spawned.map((entry) => entry.command),
        ["tailscale", LAUNCHER_CLI, HOMEBREW_CLI, APP_CLI],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the fallback that timed out, for status and serve", () => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({ platform: "darwin", installed: [APP_CLI], hang: true, spawned });

    return Effect.gen(function* () {
      for (const run of [readTailscaleStatus, ensureTailscaleServe({ localPort: 13773 })]) {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("11 seconds");
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, TailscaleCommandTimeoutError);
        assert.equal(error.executable, APP_CLI);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a fallback that exists but cannot run, for status and serve", () => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({
      platform: "darwin",
      installed: [APP_CLI],
      denied: [HOMEBREW_CLI],
      spawned,
    });

    return Effect.gen(function* () {
      for (const run of [readTailscaleStatus, ensureTailscaleServe({ localPort: 13773 })]) {
        const error = yield* run.pipe(Effect.flip);
        assert.instanceOf(error, TailscaleCommandSpawnError);
        assert.equal(error.executable, HOMEBREW_CLI);
        assert.include(String((error as TailscaleCommandSpawnError).cause), "PermissionDenied");
      }
      assert.notInclude(
        spawned.map((entry) => entry.command),
        APP_CLI,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves Windows on tailscale.exe without fallbacks", () => {
    const spawned: Array<Spawned> = [];
    const layer = layerHost({ platform: "win32", installed: [APP_CLI], spawned });

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.flip);
      assert.deepEqual(
        spawned.map((entry) => entry.command),
        ["tailscale.exe"],
      );
    }).pipe(Effect.provide(layer));
  });
});
