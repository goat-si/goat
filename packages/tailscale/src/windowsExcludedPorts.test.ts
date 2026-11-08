import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";

import {
  type ExcludedPortRange,
  findExcludedRange,
  parseExcludedPortRanges,
  readWindowsExcludedTcpPortRanges,
  reservedPortMessage,
  suggestFreePort,
} from "./windowsExcludedPorts.ts";

const encoder = new TextEncoder();

const netshSample = `

Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      5357        5357
     46648       46747
     50000       50059     *

* - Administered port exclusions.

`;

const sampleRanges = [
  { start: 5357, end: 5357 },
  { start: 46648, end: 46747 },
  { start: 50000, end: 50059 },
] satisfies ReadonlyArray<ExcludedPortRange>;

function mockHandle(stdout: string, code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
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

describe("Windows excluded TCP ports", () => {
  it("parses netsh excludedportrange output and drops invalid rows", () => {
    assert.deepEqual(parseExcludedPortRanges(netshSample), sampleRanges);
    assert.deepEqual(parseExcludedPortRanges("1 0\n70000 70001\n10 5\n80 80\nnot a range\n"), [
      { start: 80, end: 80 },
    ]);
    assert.deepEqual(parseExcludedPortRanges(""), []);
  });

  it("suggests the next free port above adjacent reserved ranges", () => {
    assert.deepEqual(findExcludedRange(46743, sampleRanges), { start: 46648, end: 46747 });
    assert.equal(findExcludedRange(46748, sampleRanges), null);
    assert.equal(suggestFreePort(46743, sampleRanges), 46748);
    assert.equal(
      suggestFreePort(46648, [
        { start: 46648, end: 46747 },
        { start: 46748, end: 46750 },
      ]),
      46751,
    );
    assert.equal(suggestFreePort(65535, sampleRanges), null);
  });

  it("names a reserved range, a single port, and a port with no alternative", () => {
    assert.equal(
      reservedPortMessage(46743, { start: 46648, end: 46747 }, 46748),
      "Windows reserves TCP ports 46648\u201346747, so Tailscale HTTPS cannot use port 46743. Choose another port, such as 46748.",
    );
    assert.equal(
      reservedPortMessage(5357, { start: 5357, end: 5357 }, 5358),
      "Windows reserves TCP port 5357, so Tailscale HTTPS cannot use port 5357. Choose another port, such as 5358.",
    );
    assert.equal(
      reservedPortMessage(46743, { start: 46648, end: 46747 }, null),
      "Windows reserves TCP ports 46648\u201346747, so Tailscale HTTPS cannot use port 46743. Choose another port.",
    );
  });

  it.effect("does not spawn netsh off Windows", () => {
    let spawns = 0;
    const layer = Layer.mergeAll(
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawns += 1;
            return mockHandle("");
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      assert.deepEqual(yield* readWindowsExcludedTcpPortRanges().pipe(Effect.provide(layer)), []);
      assert.equal(spawns, 0);
    });
  });

  it.effect("reads both Windows stacks and keeps going when one netsh fails", () => {
    const commands: string[] = [];
    const layer = Layer.mergeAll(
      Layer.succeed(HostProcess.Platform, "win32"),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die("unexpected command");
          }
          commands.push(`${command.command} ${command.args.join(" ")}`);
          return Effect.succeed(
            mockHandle(
              command.args[1] === "ipv6" ? "" : netshSample,
              command.args[1] === "ipv6" ? 1 : 0,
            ),
          );
        }),
      ),
    );
    return Effect.gen(function* () {
      assert.deepEqual(
        yield* readWindowsExcludedTcpPortRanges().pipe(Effect.provide(layer)),
        sampleRanges,
      );
      assert.deepEqual(commands.toSorted(), [
        "netsh.exe int ipv4 show excludedportrange protocol=tcp",
        "netsh.exe int ipv6 show excludedportrange protocol=tcp",
      ]);
    });
  });
});
