import type { RunResult } from "@cursor/sdk";
import { RunId } from "@goat/contracts";
import { it as effectIt } from "@effect/vitest";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { shouldRetryCursorRun } from "./adapter.ts";
import { harness, runId } from "./adapter.testkit.ts";

const savedTask = {
  taskId: "run-fixture",
  acceptedAppRunId: RunId.make("app-run-fixture"),
  source: { repository: "https://github.com/fixture/repo", branch: "feature", sha: "a".repeat(40) },
  localChangesExcluded: true,
  status: "running" as const,
  tracking: "live" as const,
  updatedAt: "2026-10-25T00:00:00.000Z",
};

describe("Cursor Cloud automatic retry", () => {
  // RunError.code is optional; a refusal can explain itself only in its message.
  it.each<{ name: string; message: string; retry: boolean }>([
    {
      name: "an unexpected stop",
      message: "The agent stopped because of an unexpected error.",
      retry: true,
    },
    {
      name: "a billing refusal without a code",
      message: "You have no usage credits left. Update your billing plan to continue.",
      retry: false,
    },
    {
      name: "a sign-in refusal without a code",
      message: "Authentication required. Sign in to Cursor again.",
      retry: false,
    },
  ])("decides whether to retry $name from the message alone", ({ message, retry }) => {
    const result: RunResult = { id: "run-fixture", status: "error", error: { message } };
    expect(shouldRetryCursorRun(savedTask, result, false)).toBe(retry);
  });
});

describe("Cursor Cloud automatic retry progress", () => {
  // The session manager fails a turn whose retry row stays running through 15 silent minutes,
  // and polling a cloud run emits nothing, so the row must settle once the retry is accepted.
  effectIt.effect("settles the retry row once the retried run is accepted, not when it ends", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const retried = yield* Deferred.make<void>();
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* h.runtime.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      h.setResult({
        id: runId,
        status: "error",
        error: { message: "The agent stopped because of an unexpected error." },
      });
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.streamStarted);
      h.send.mockImplementationOnce(async () => {
        h.setRunningLookup(true);
        Deferred.doneUnsafe(retried, Effect.void);
        return { ...h.nativeRun, id: "run-retry" };
      });
      yield* h.finish;
      yield* Deferred.await(retried);
      for (let minute = 0; minute < 16; minute++) yield* TestClock.adjust("1 minute");

      expect(
        events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? [event.turnItem.status]
            : [],
        ),
      ).toEqual(["running", "completed"]);
      expect(events.some((event) => event.type === "turn.terminal")).toBe(false);
      expect(h.cancelRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped),
  );
});
