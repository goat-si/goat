import { it as effectIt } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { CodexDetachedAppServerError } from "../provider/CodexDetachedAppServer.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect("Codex admission refuses a goal block and permits a turn after it clears", () =>
  Effect.gen(function* () {
    let blocked = true;
    const detail =
      "Codex is still running a goal on this thread from before the restart. Send /goal pause or /goal clear to continue here.";
    const ensureCodexAdmission = (
      _thread: unknown,
      options?: { readonly allowGoalControl?: boolean },
    ) =>
      blocked && !options?.allowGoalControl
        ? Effect.fail(new CodexDetachedAppServerError({ detail }))
        : Effect.void;
    const previousTurn = { runStatus: "completed", turnStatus: "completed" } as const;
    const refused = makeLocalCommandHarness({
      text: "Continue",
      ensureCodexAdmission,
      previousTurn,
    });
    yield* refused.start;
    expect(refused.startRootRun).not.toHaveBeenCalled();
    expect(JSON.stringify(refused.events)).toContain(detail);
    for (const text of ["/goal pause", "/goal clear", "/goal"]) {
      const control = makeLocalCommandHarness({ text, ensureCodexAdmission, previousTurn });
      yield* control.start;
      expect(control.startRootRun).toHaveBeenCalledOnce();
    }
    for (const text of ["/goal resume", "/goal new objective"]) {
      const disallowed = makeLocalCommandHarness({ text, ensureCodexAdmission, previousTurn });
      yield* disallowed.start;
      expect(disallowed.startRootRun).not.toHaveBeenCalled();
    }
    blocked = false;
    const released = makeLocalCommandHarness({
      text: "Continue",
      ensureCodexAdmission,
      previousTurn,
    });
    yield* released.start;
    expect(released.startRootRun).toHaveBeenCalledOnce();
  }),
);

effectIt.effect("Codex admission refuses a retained stop fence", () =>
  Effect.gen(function* () {
    const detail = "Codex is running work on this thread from before the restart.";
    for (const text of ["Continue", "/goal pause", "/goal clear", "/goal"]) {
      const harness = makeLocalCommandHarness({
        text,
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
        ensureCodexAdmission: () => Effect.fail(new CodexDetachedAppServerError({ detail })),
      });
      yield* harness.start;
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.events)).toContain(detail);
    }
  }),
);
