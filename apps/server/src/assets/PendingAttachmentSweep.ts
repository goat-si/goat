import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ServerConfig from "../config.ts";
import * as AttachmentFileLeases from "./AttachmentFileLeases.ts";
import {
  makeSweepCursor,
  nodeSweepFileSystem,
  type SweepFileSystem,
} from "./PendingAttachmentSweepCursor.ts";

const intervalMs = 15 * 60_000;

export class PendingAttachmentSweep extends Context.Service<
  PendingAttachmentSweep,
  {
    readonly request: Effect.Effect<void>;
  }
>()("goat/assets/PendingAttachmentSweep") {}

export const layerWithFileSystem = (fileSystem: SweepFileSystem) =>
  Layer.effect(
    PendingAttachmentSweep,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const leases = yield* AttachmentFileLeases.AttachmentFileLeases;
      const wakes = yield* Queue.sliding<void>(1);
      const cursor = makeSweepCursor({
        attachmentsDir: config.attachmentsDir,
        withInactiveFile: leases.withInactiveFile,
        fileSystem,
      });
      yield* Effect.addFinalizer(() =>
        cursor.close.pipe(
          Effect.catch(() =>
            Effect.logWarning("Attachment expiration cursor close remains uncertain."),
          ),
        ),
      );
      let nextDue = -Infinity;
      const request = Effect.fn("PendingAttachmentSweep.request")(function* () {
        yield* Queue.offer(wakes, undefined);
      })();
      const consume = Effect.fn("PendingAttachmentSweep.consume")(function* () {
        yield* Queue.take(wakes);
        const now = yield* Clock.currentTimeMillis;
        if (now < nextDue) return;
        const report = yield* cursor.step(now);
        nextDue = (yield* Clock.currentTimeMillis) + intervalMs;
        yield* Effect.logInfo("Attachment expiration sweep step.", report);
      });
      yield* consume().pipe(Effect.forever, Effect.forkScoped);
      yield* Effect.sleep(intervalMs).pipe(
        Effect.andThen(request),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* request;
      return PendingAttachmentSweep.of({ request });
    }),
  );

export const layer = layerWithFileSystem(nodeSweepFileSystem).pipe(
  Layer.provideMerge(AttachmentFileLeases.layer),
);
