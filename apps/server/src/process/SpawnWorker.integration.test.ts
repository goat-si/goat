// @effect-diagnostics nodeBuiltinImport:off -- This checks which thread owns a real child process.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NonBlockingSpawner from "./NonBlockingSpawner.ts";

it.live("a Windows-mode launch keeps the native process handle off the server thread", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "-e",
        "process.stdout.write('ready'); process.stdin.resume()",
      ]),
    );
    expect(yield* child.stdout.pipe(Stream.take(1), Stream.decodeText(), Stream.mkString)).toBe(
      "ready",
    );
    expect(process.getActiveResourcesInfo()).not.toContain("ProcessWrap");
  }).pipe(
    Effect.scoped,
    Effect.provide(NonBlockingSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.provideService(HostProcess.Platform, "win32"),
  ),
);
