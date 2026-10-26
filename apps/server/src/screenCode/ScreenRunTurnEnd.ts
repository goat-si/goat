import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import { forkParked } from "../serverActivation.ts";
import { ScreenRunService } from "./ScreenRunService.ts";

const OPEN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The event stream is only a wakeup; persisted run state decides terminal cleanup. */
export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const screen = yield* ScreenRunService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
    Effect.gen(function* () {
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
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("screen turn cleanup failed", { cause })),
  )));

  const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
  if (Option.isSome(browser)) {
    type TabState = { threadId: string; tabId: string; private: boolean; agentStopped: boolean; humanControls: boolean };
    const tabKey = (tab: TabState) => `${tab.threadId}\u0000${tab.tabId}`;
    let previous = new Map((yield* browser.value.sessions).map((tab) => [tabKey(tab), tab]));
    yield* forkParked(Stream.runForEach(browser.value.sessionChanges, () =>
      Effect.gen(function* () {
        const current = new Map((yield* browser.value.sessions).map((tab) => [tabKey(tab), tab]));
        for (const [key, before] of previous) {
          const after = current.get(key);
          const kind = !after || (!before.agentStopped && after.agentStopped) ? "stop"
            : !before.private && after.private ? "private"
            : !before.humanControls && after.humanControls ? "takeover" : undefined;
          if (kind) yield* screen.controlChanged({ kind, threadId: before.threadId, tabId: before.tabId });
        }
        previous = current;
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("screen browser cutoff failed", { cause })),
    )));
  }

}));
