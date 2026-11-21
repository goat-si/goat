import * as Cause from "effect/Cause";
import { it as effectIt } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { type MemoryTaskGrantCeiling, RunId } from "@goat/contracts";
import * as Logger from "effect/Logger";
import * as Effect from "effect/Effect";
import * as MemorySnapshot from "../memory/MemorySnapshot.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

// Observe the closure installed by the real start service; authority is reread per send.
effectIt.effect("refreshes each send, omits none and failures, and fences a moved run", () =>
  Effect.gen(function* () {
    let grant: MemoryTaskGrantCeiling = "read_write";
    let fail = false;
    let interrupt = false;
    let threadReads = 0;
    let policyReads = 0;
    let moved = false;
    let selections = 0;
    let moveDuringRead = false;
    const diagnostics: Array<unknown> = [];
    const logger = Logger.make(({ message }) => diagnostics.push(message));
    const snapshot = { protocolVersion: 1, items: [], renderedText: "fixture frame" } as never;
    const harness = makeLocalCommandHarness({
      text: "Continue",
      failReadsAfterRunning: true,
      memory: {
        policy: () =>
          Effect.sync(() => {
            policyReads++;
            return { grant, policyEpoch: 7 };
          }),
        currentRun: () => {
          threadReads++;
          return moved ? undefined : RunId.make("run-native-account-command");
        },
        select: (_threadId, policy, currentPolicy) =>
          Effect.gen(function* () {
            selections++;
            if (interrupt) return yield* Effect.interrupt;
            expect(policy).toEqual(yield* currentPolicy);
            if (fail)
              return yield* new MemorySnapshot.MemorySnapshotError({
                cause: "fixture read failure",
              });
            if (moveDuringRead) moved = true;
            return snapshot;
          }),
      },
    });
    yield* harness.start;
    const refresh = harness.startRootRun.mock.calls[0]![0].refreshMemoryContext;
    expect(refresh).toBeDefined();
    expect(selections).toBe(0);
    expect(yield* refresh!()).toBe(snapshot);
    expect(yield* refresh!()).toBe(snapshot);
    expect(selections).toBe(2);
    grant = "none";
    const readsBeforeNone = threadReads;
    const policiesBeforeNone = policyReads;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(2);
    expect(threadReads).toBe(readsBeforeNone);
    expect(policyReads).toBe(policiesBeforeNone + 1);
    grant = "read";
    expect(yield* refresh!()).toBe(snapshot);
    fail = true;
    expect(yield* refresh!().pipe(Effect.provide(Logger.layer([logger])))).toBeUndefined();
    expect(diagnostics).toEqual([
      [
        "Memory refresh unavailable",
        { threadId: "thread-native-account-command", runId: "run-native-account-command" },
      ],
    ]);
    expect(selections).toBe(4);
    fail = false;
    moveDuringRead = true;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(5);
    moved = true;
    expect(yield* refresh!()).toBeUndefined();
    expect(selections).toBe(5);
    moved = false;
    moveDuringRead = false;
    interrupt = true;
    const exit = yield* Effect.exit(refresh!().pipe(Effect.provide(Logger.layer([logger]))));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(diagnostics).toHaveLength(1);
  }),
);
