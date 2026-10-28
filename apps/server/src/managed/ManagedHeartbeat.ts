// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Early bootstrap publishes before the Effect application is loaded.
import type { DesktopBackendHealth, ManagedWatchdogBootstrap } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { makeLoopObserver } from "@goat/shared/managedRecoveryPolicy";
import {
  makeMailbox,
  publishMailbox,
  readMailbox,
  startLoopWatchdog,
} from "./LoopWatchdogWorker.ts";

type Phase = DesktopBackendHealth["phase"];
export const makeManagedHeartbeat = Effect.fn("ManagedHeartbeat.make")(function* (options: {
  readonly generation: string;
  readonly ready?: boolean;
  readonly writeHealth: (frame: DesktopBackendHealth) => Effect.Effect<void>;
  readonly retireSelf: () => Effect.Effect<void>;
}) {
  const mailbox = makeMailbox();
  const clock = yield* Clock.Clock;
  const nowMs = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  const started = nowMs();
  const observer = makeLoopObserver(started);
  const wake = yield* Queue.bounded<void>(1);
  const actions = yield* Queue.bounded<Deferred.Deferred<void>>(1);
  let pending: DesktopBackendHealth | undefined;
  let activeWrites = 0;
  let sequence = 0;
  let terminal = false;
  let retirement: Deferred.Deferred<void> | undefined;
  yield* Queue.take(wake).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const frame = pending;
        pending = undefined;
        if (!frame) return Effect.void;
        activeWrites = 1;
        return options.writeHealth(frame).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              activeWrites = 0;
            }),
          ),
        );
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Queue.take(actions).pipe(
    Effect.flatMap((done) =>
      options.retireSelf().pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  const publish = Effect.fn("ManagedHeartbeat.publish")((phase: Phase) =>
    Effect.sync(() => {
      publishMailbox(mailbox, phase);
    }),
  );
  if (options.ready) yield* publish("ready");
  let snapshot = readMailbox(mailbox) ?? {
    sequence: 0,
    phase: "starting" as const,
    ready: false,
    stopping: false,
  };
  const observe = Effect.gen(function* () {
    if (terminal) return;
    snapshot = readMailbox(mailbox) ?? snapshot;
    const now = nowMs();
    const status = observer.sample(now, snapshot.sequence, snapshot.ready, snapshot.stopping);
    if (status === "stopping") return;
    if (status === "main-silent") {
      terminal = true;
      Atomics.store(mailbox, 4, 1);
      retirement = yield* Deferred.make<void>();
      yield* Queue.offer(actions, retirement);
    }
    pending = {
      version: 1,
      type: "backendHealth",
      generation: options.generation,
      observerSequence: ++sequence,
      mainSequence: snapshot.sequence,
      phase: snapshot.phase,
      verdict: terminal ? "main-silent" : "healthy",
    };
    Queue.offerUnsafe(wake, undefined);
  });
  return {
    publish,
    observe,
    drainActions: Effect.suspend(() => (retirement ? Deferred.await(retirement) : Effect.void)),
    publisherState: Effect.sync(() => ({
      activeWrites,
      pendingSnapshots: pending ? 1 : 0,
      retainedBytes: activeWrites * 512 + (pending ? 512 : 0),
    })),
  };
});

export interface InstalledHeartbeat {
  readonly publish: (phase: Phase) => boolean;
  readonly isRetired: () => boolean;
  readonly close: () => Promise<void>;
}
export function installManagedHeartbeat(
  bootstrap: ManagedWatchdogBootstrap,
): Promise<InstalledHeartbeat> {
  const mailbox = makeMailbox();
  const worker = startLoopWatchdog(bootstrap, mailbox);
  return new Promise((resolve, reject) => {
    let installed = false;
    let closing = false;
    const unavailable = (error: Error) => {
      if (!installed) {
        reject(error);
        return;
      }
      if (!closing) process.exit(80);
    };
    worker.once("error", unavailable);
    worker.once("exit", (code) => unavailable(new Error(`Managed observer exited (${code})`)));
    worker.once("message", (message) => {
      if (message !== "installed") {
        reject(new Error("Invalid managed observer acknowledgement"));
        return;
      }
      installed = true;
      let phase: Phase = "starting";
      const publish = (next: Phase) => {
        phase = next;
        return publishMailbox(mailbox, next);
      };
      publish(phase);
      const timer = setInterval(() => publish(phase), 2_000);
      timer.unref();
      worker.unref();
      const stop = () => {
        closing = true;
        publish("stopping");
        clearInterval(timer);
      };
      // Publish stopping before the CLI's signal handler starts asynchronous scope teardown.
      process.prependListener("SIGTERM", stop);
      process.prependListener("SIGINT", stop);
      resolve({
        publish,
        isRetired: () => Atomics.load(mailbox, 4) !== 0,
        close: async () => {
          stop();
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
          if (Atomics.load(mailbox, 4) === 0) await worker.terminate();
        },
      });
    });
  });
}
