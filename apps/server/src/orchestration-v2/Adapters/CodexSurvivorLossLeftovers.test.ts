import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type { CodexSurvivors } from "../../provider/CodexSurvivors.ts";
import { settleSurvivorSessionLoss } from "./CodexSurvivorSessionLoss.ts";
import {
  clearDeadSurvivorFences,
  type SurvivorEntry,
  type SurvivorSignal,
} from "./CodexSurvivorFenceMaintenance.ts";

const binding = {
  instanceId: ProviderInstanceId.make("codex"),
  recordName: "record",
  threadId: ThreadId.make("thread"),
  sourceRunId: RunId.make("run"),
  nativeThreadId: "native-thread",
  nativeTurnId: "T",
};

it.effect("session loss with possible leftover processes retains admission fence", () =>
  Effect.gen(function* () {
    let fenced = false;
    let detail = "";
    const service = {
      classifyRecord: () => Effect.succeed({ type: "gone" as const, possibleLeftovers: [12] }),
      recordStopObligation: () =>
        Effect.sync(() => {
          fenced = true;
        }),
      getStopObligations: () => Effect.succeed([{ record: binding, block: binding }]),
      clearStopObligation: () =>
        Effect.sync(() => {
          fenced = false;
        }),
    } as unknown as CodexSurvivors["Service"];
    yield* settleSurvivorSessionLoss({
      binding,
      service,
      settle: (value) =>
        Effect.sync(() => {
          detail = value;
        }),
    });
    assert.isTrue(fenced);
    assert.equal(
      detail,
      "GOAT could not confirm the Codex process from before the restart stopped.",
    );
  }),
);

it.effect("retained survivor fence remains while process leftovers are possible", () =>
  Effect.gen(function* () {
    let cleared = false;
    let leftovers = true;
    const service = {
      classifyRecord: () =>
        Effect.sync(() => ({ type: "gone" as const, possibleLeftovers: leftovers ? [12] : [] })),
      release: () => Effect.void,
      clearStopObligation: () =>
        Effect.sync(() => {
          cleared = true;
        }),
    } as unknown as CodexSurvivors["Service"];
    const entry: SurvivorEntry = {
      nativeTurnId: binding.nativeTurnId,
      binding,
      service,
      signals: yield* Queue.bounded<SurvivorSignal>(64),
      gate: yield* Semaphore.make(1),
      lost: yield* Deferred.make<void>(),
      done: undefined,
      providerTurnId: undefined,
      stopRecorded: true,
      interruptSent: false,
      overflow: false,
      terminalEvidence: false,
      retainingFence: true,
      fenceWriteFailed: false,
      conflicts: new Map(),
      stops: { pending: new Map(), done: new Set(), running: false },
    };
    const waiting = new Map([[binding.nativeThreadId, entry]]);
    yield* clearDeadSurvivorFences({ entries: [entry], waiting });
    assert.isFalse(cleared);
    assert.isTrue(entry.retainingFence);
    assert.equal(waiting.get(binding.nativeThreadId), entry);
    leftovers = false;
    yield* clearDeadSurvivorFences({ entries: [entry], waiting });
    assert.isTrue(cleared);
    assert.isFalse(waiting.has(binding.nativeThreadId));
  }),
);
