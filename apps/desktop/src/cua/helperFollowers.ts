import type { DesktopCuaFrame, DesktopCuaPrivateModeReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import type { HelperSession } from "./ComputerUseHelper.ts";
import { makeFrameFollower } from "./frameFollower.ts";
import { makePrivateModeFollower } from "./privateModeWatch.ts";

type Followed = Pick<
  HelperSession,
  "watch" | "unwatch" | "onEvent" | "canWatch" | "canFrame" | "frames" | "onFrame"
>;

/**
 * What follows each helper generation on the server's behalf: the secret-field watch (#1235)
 * and the window captures for the live picture (#1370). Both take requests from this host's
 * own server and send what the helper reports back to it.
 */
export const makeHelperFollowers = Effect.fn("makeHelperFollowers")(function* (deps: {
  readonly publisher: DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"];
  readonly newWatchId: () => string;
}) {
  const safety = yield* Queue.unbounded<DesktopCuaPrivateModeReport>();
  // Only the newest frame matters to a viewer.
  const frames = yield* Queue.sliding<DesktopCuaFrame>(4);
  const retries = yield* Queue.unbounded<() => void>();
  const retryLater = (retry: () => void) => Queue.offerUnsafe(retries, retry);
  const privateMode = makePrivateModeFollower({
    publish: (report) => Queue.offerUnsafe(safety, report),
    newWatchId: deps.newWatchId,
    retryLater,
  });
  const capture = makeFrameFollower({
    publish: (frame) => Queue.offerUnsafe(frames, frame),
    retryLater,
  });
  return {
    attach: (session: Followed) =>
      Effect.sync(() => {
        void privateMode.attach(session);
        void capture.attach(session);
      }),
    detach: Effect.sync(() => {
      privateMode.detach();
      capture.detach();
    }),
    listen: Effect.gen(function* () {
      yield* Stream.runForEach(deps.publisher.cuaWatch, (active) =>
        Effect.sync(() => void privateMode.setWatching(active)),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(deps.publisher.cuaFrames, (request) =>
        Effect.sync(() => void capture.setRequest(request)),
      ).pipe(Effect.forkScoped);
      yield* Stream.runForEach(Stream.fromQueue(safety), deps.publisher.publishCuaSafety).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(Stream.fromQueue(frames), deps.publisher.publishCuaFrame).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(Stream.fromQueue(retries), (retry) =>
        Effect.sleep("1 second").pipe(Effect.andThen(Effect.sync(retry))),
      ).pipe(Effect.forkScoped);
    }),
  };
});
