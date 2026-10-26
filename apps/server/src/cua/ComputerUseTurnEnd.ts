/**
 * Ends computer use controls that no turn can use any more: when a thread's last open run ends,
 * and when a person turns computer use off. Without this a finished thread's control stays
 * active until it expires, and its session reads "Agent controlling" for up to an hour (#1360).
 *
 * @module ComputerUseTurnEnd
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const OPEN = new Set(["preparing", "queued", "starting", "running", "waiting", "pending"]);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
    if (Option.isNone(leases)) return;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        // A run's end, or the end of a native subagent or its turn, which may outlive the run.
        // A subagent's events carry its child thread, so every acting control is checked.
        (event.type === "run.updated" ||
          event.type === "provider-turn.updated" ||
          event.type === "subagent.updated") &&
        !OPEN.has(event.payload.status)
          ? leases.value.settle
          : // A control on every app lasts only while its thread stays in full access.
            event.type === "thread.runtime-mode-updated"
            ? leases.value.changed
            : Effect.void,
      ),
    );
    yield* (yield* settings.subscribeChanges).pipe(
      Stream.runForEach((value) => (value.enableCua ? Effect.void : leases.value.disable)),
      Effect.forkScoped,
    );
  }),
);
