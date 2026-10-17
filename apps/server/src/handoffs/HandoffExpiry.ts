import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as Handoffs from "./Handoffs.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const handoffs = yield* Handoffs.Handoffs;
    const setup = yield* SshHostSetup.SshHostSetup;
    const scheduler = yield* Scheduler.Scheduler;
    // Registration runs once after startup recovery, then on each shared scheduler tick.
    yield* scheduler.register(
      "handoff-expiry",
      handoffs.sweep.pipe(Effect.andThen(setup.resumeContinuations)),
    );
  }),
);
