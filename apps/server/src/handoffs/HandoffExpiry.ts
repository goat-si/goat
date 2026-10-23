import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as ProviderSettings from "../provider/ProviderSettings.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as Handoffs from "./Handoffs.ts";
import * as HandoffWakeReactor from "./HandoffWakeReactor.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const homeRequests = yield* HomeRequests.CodexHomeRequests;
    const providerSettings = yield* ProviderSettings.ProviderSettings;
    const handoffs = yield* Handoffs.Handoffs;
    const setup = yield* SshHostSetup.SshHostSetup;
    const scheduler = yield* Scheduler.Scheduler;
    const wakes = yield* HandoffWakeReactor.HandoffWakeReactor;
    yield* wakes.start;
    // Registration runs once after startup recovery, then on each shared scheduler tick.
    yield* scheduler.register(
      "handoff-expiry",
      handoffs.sweep.pipe(
        // Expiries this sweep made wake their threads on the same tick.
        Effect.andThen(wakes.reconcile),
        Effect.andThen(setup.resumeContinuations),
        Effect.andThen(homeRequests.resumeContinuations),
        Effect.andThen(providerSettings.resumeContinuations),
      ),
    );
  }),
).pipe(Layer.provide(HandoffWakeReactor.layer));
