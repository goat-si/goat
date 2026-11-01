import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

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
