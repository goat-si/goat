import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export function makeHandle(input: {
  readonly pid: number;
  readonly onKill: () => void;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly output?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: input.output ?? Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export const unusedHttpClient = HttpClient.make(() => Effect.die("unused"));

export function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
) {
  // Keep body decoding on TestClock instead of an untracked Web Response promise.
  return Object.defineProperty(
    HttpClientResponse.fromWeb(request, Response.json(body, { status })),
    "json",
    {
      value: Effect.succeed(body),
    },
  );
}

import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import type * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

export const makeTransportSpawner = Effect.fnUntraced(function* (
  options: {
    transport?: string;
    failSpawn?: number;
    isRunning?: Effect.Effect<boolean>;
  } = {},
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.TUNNEL_TRANSPORT_PROTOCOL;
      if (options.transport === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
      else process.env.TUNNEL_TRANSPORT_PROTOCOL = options.transport;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
        else process.env.TUNNEL_TRANSPORT_PROTOCOL = previous;
      }),
  );
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const killed: Array<number> = [];
  const outputs: Array<Queue.Queue<Uint8Array>> = [];
  const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
  const started = yield* Queue.unbounded<number>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("Expected standard command.");
      }
      const index = spawned.length;
      spawned.push(command);
      if (index === options.failSpawn) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "cloudflared temporarily unavailable",
        });
      }
      const output = yield* Queue.unbounded<Uint8Array>();
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      outputs[index] = output;
      exits[index] = exit;
      const handle = ChildProcessSpawner.makeHandle({
        ...makeHandle({
          pid: 800 + index,
          exitCode: Deferred.await(exit),
          output: Stream.fromQueue(output),
          onKill: () => {
            killed.push(800 + index);
            Deferred.doneUnsafe(exit, Exit.succeed(ChildProcessSpawner.ExitCode(143)));
          },
        }),
        isRunning: options.isRunning ?? Effect.succeed(true),
      });
      yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
      yield* Queue.offer(started, index);
      return handle;
    }),
  );
  const emit = (index: number, lines: string) =>
    Effect.gen(function* () {
      const output = outputs[index];
      if (!output) return yield* Effect.die("Missing relay output");
      yield* Queue.offer(output, new TextEncoder().encode(lines));
    });
  const observe = (
    runtime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
    index: number,
    lines = "",
  ) =>
    emit(index, lines + "2026-10-16T20:30:00Z INF Registered tunnel connection connIndex=0\n").pipe(
      Effect.andThen(Stream.runHead(runtime.tunnelConnected)),
    );
  return { spawner, spawned, killed, exits, started, emit, observe };
});
