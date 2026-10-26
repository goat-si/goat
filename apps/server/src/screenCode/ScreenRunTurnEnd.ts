import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ScreenRunService } from "./ScreenRunService.ts";

const OPEN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const handleScreenRunEvent = Effect.fn("ScreenRunTurnEnd.handleEvent")(function* (input: {
  readonly event: import("@goat/contracts").OrchestrationV2DomainEvent;
  readonly screen: ScreenRunService["Service"];
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
}) {
  const { event, screen, orchestrator } = input;
  if (event.type === "message.updated" && event.payload.role === "user") {
    yield* screen.controlChanged({ kind: "newMessage", threadId: event.threadId });
    return;
  }
  if (event.type !== "run.updated" || OPEN.has(event.payload.status)) return;
  const projection = yield* orchestrator.getThreadProjection(event.threadId).pipe(Effect.option);
  if (Option.isNone(projection)) return;
  const run = projection.value.runs.find((candidate) => candidate.id === event.payload.id);
  if (!run || OPEN.has(run.status)) return;
  yield* screen.finishRun({ threadId: event.threadId, runId: run.id, reason: "turnEnded" });
});

/** The event stream is only a wakeup; persisted run state decides terminal cleanup. */
export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const screen = yield* ScreenRunService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
    handleScreenRunEvent({ event, screen, orchestrator }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("screen turn cleanup failed", { cause })),
    ),
  ));

}));
