import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import type {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ScreenHostCall,
  ScreenImageMetadata,
  ScreenImage,
} from "@goat/contracts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { ScreenCursorPhases } from "../cua/ScreenCursorPhases.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = (reauthorize?: () => Effect.Effect<void>) => ({
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits({ imageBytes: 6 }),
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as ThreadId,
      providerSessionId: "s",
      providerInstanceId: "p" as ProviderInstanceId,
    },
    ...(reauthorize ? { reauthorize } : {}),
  },
});
const tab = {
  id: "target",
  kind: "tab" as const,
  environmentId: "env",
  runId: "r",
  turnId: "t",
  generation: 0,
};
const call = (callId: number): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  targetRef: tab,
  method: "click",
  args: {},
  deadlineMillis: 60_000,
});

it.effect("a cut before the first host call refuses that call", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          dispatched++;
          return { category: "confirmed" as const };
        }),
    });
    bridge.cutCellNow("r", "t", "c");
    const reply = yield* bridge.handle(call(1), context());
    expect(reply?.outcome).toBe("error");
    if (reply?.outcome === "error") expect(reply.error?.code).toBe("stopped");
    expect(dispatched).toBe(0);
  }),
);

it.effect("preview calls require live reauthorization on every dispatch", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    let authorized = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: () =>
        Effect.sync(() => {
          dispatched++;
          return {
            value: true,
            category: "confirmed" as const,
            evidence: ["observation:test"],
          };
        }),
    });
    const first = yield* bridge.handle(
      call(1),
      context(() =>
        Effect.sync(() => {
          authorized++;
        }),
      ),
    );
    const second = yield* bridge.handle(call(2), context());
    expect(first?.outcome).toBe("ok");
    expect(second && "error" in second ? second.error?.code : undefined).toBe("permission_denied");
    expect(dispatched).toBe(1);
    expect(authorized).toBe(1);
  }),
);

it.effect("the host retains bounded images and guest replies contain metadata only", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: (request) => {
        const metadata: ScreenImageMetadata = {
          imageRef: `i${request.callId}`,
          callId: request.callId,
          targetId: "target",
          observationId: "o",
          regionId: "g",
          region: { kind: "viewport", x: 0, y: 0, width: 1, height: 1 },
          pixelWidth: 1,
          pixelHeight: 1,
          scale: 1,
          mimeType: "image/png",
        };
        const image: ScreenImage = {
          ...metadata,
          bytes: Buffer.from(`123${request.callId}`).toString("base64"),
        };
        return Effect.succeed({
          value: { observationId: "o", tree: "button Save", image },
          image,
          imageMetadata: metadata,
          category: "unverifiable" as const,
        });
      },
    });
    const one = yield* bridge.handle(
      { ...call(1), method: "observe" },
      context(() => Effect.void),
    );
    const two = yield* bridge.handle(
      { ...call(2), method: "observe" },
      context(() => Effect.void),
    );
    const collected = yield* bridge.takeCellImages("r", "t", "c");
    expect(JSON.stringify(one)).not.toContain("MTIzNA");
    expect(JSON.stringify(two)).not.toContain("MTIzNA");
    expect(one?.value).toMatchObject({
      observationId: "o",
      tree: "button Save",
      image: { imageRef: "i1" },
    });
    expect(collected.images.map((image) => image.imageRef)).toEqual(["i2"]);
    expect(collected.imageMetadata[0]?.omitted).toBe(true);
  }),
);

it.effect(
  "transport success without evidence is unverifiable and availability comes from the dispatcher",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher({
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () => Effect.succeed({ value: true, category: "confirmed" }),
      });
      const available = yield* bridge.availability(context());
      const { targetRef: _targetRef, ...untargeted } = call(1);
      const result = yield* bridge.handle({ ...untargeted, method: "list_apps" }, context());
      const collected = yield* bridge.takeCellImages("r", "t", "c");
      expect(available).toEqual([{ kind: "app", available: true }]);
      expect(result?.outcome).toBe("ok");
      expect(collected.journal[0]?.receipt).toMatchObject({
        category: "unverifiable",
        dispatched: true,
      });
    }),
);

it.effect("a refused preview call is never marked dispatched", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ category: "confirmed", evidence: ["observation:o"] }),
    });
    const result = yield* bridge.handle(call(1), context());
    const collected = yield* bridge.takeCellImages("r", "t", "c");
    expect(result && "error" in result ? result.error?.code : undefined).toBe("permission_denied");
    expect(collected.journal[0]?.receipt).toMatchObject({ category: "refused", dispatched: false });
  }),
);

it.effect("discard and finishTurn release cell and target state", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    yield* bridge.invalidateTarget("r", "t", "target", "replaced");
    const stale = yield* bridge.handle(call(1), context());
    expect(stale && "error" in stale ? stale.error?.code : undefined).toBe("stale_reference");
    yield* bridge.discardCell("r", "t", "c", "stopped");
    expect((yield* bridge.takeCellImages("r", "t", "c")).journal).toHaveLength(0);
    const late = yield* bridge.handle(call(2), context());
    expect(late && "error" in late ? late.error?.code : undefined).toBe("stopped");
    expect(
      (yield* bridge.takeCellImages("r", "t", "c")).journal[0]?.receipt.safety?.possibleCommit,
    ).toBe(false);
    yield* bridge.finishTurn("r", "t");
    const after = yield* bridge.handle(call(1), context());
    expect(after && "error" in after ? after.error?.code : undefined).not.toBe("stale_reference");
  }),
);

it.effect("a cell's targets and key labels outlive its taken state until its row takes them", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (each) =>
        Effect.succeed(
          each.method === "select_tab"
            ? { value: { targetRef: { ...tab, id: "opened" } }, category: "confirmed" as const }
            : { category: "confirmed" as const, evidence: ["test"] },
        ),
    });
    const live = context(() => Effect.void);
    const press = (callId: number, args: unknown): ScreenHostCall => ({
      ...call(callId),
      method: "press_key",
      args: [args] as ScreenHostCall["args"],
    });
    const { targetRef: _targetRef, ...untargeted } = call(1);
    yield* bridge.handle(
      { ...untargeted, method: "select_tab", args: [{ tabId: "x" }] },
      context(),
    );
    yield* bridge.handle(press(2, { key: "Enter" }), live);
    yield* bridge.handle(press(3, { key: "a" }), live);
    yield* bridge.handle(press(4, { key: "a", modifiers: ["Meta"] }), live);
    bridge.takeCellImagesNow("r", "t", "c");
    bridge.discardCellNow("r", "t", "c");
    const facts = bridge.takeCellFacts("r", "t", "c");
    expect(facts.targets).toEqual(["opened", "target"]);
    expect([...facts.keys]).toEqual([
      [2, "Enter"],
      [4, "cmd+a"],
    ]);
    expect(bridge.takeCellFacts("r", "t", "c").targets).toEqual([]);
    yield* bridge.handle(press(5, { key: "Tab" }), { ...live, cellId: "d" });
    yield* bridge.finishTurn("r", "t");
    expect(bridge.takeCellFacts("r", "t", "d").targets).toEqual([]);
  }),
);

it.effect("trusted host call phases end when the cell is cut", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const bridge = new ScreenHostBridge(
      new ScreenCursorPhases((event) => events.push(event.phase)),
    );
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ value: true, category: "confirmed", evidence: ["done"] }),
    });
    const reply = yield* bridge.handle(
      call(1),
      context(() => Effect.void),
    );
    expect(reply?.outcome).toBe("ok");
    yield* bridge.cutCell("r", "t", "c", "stopped");
    expect(events).toEqual(["thinking", "resting", "hidden"]);
  }),
);

it.effect("takeover yields the cursor while private cutoff hides it", () =>
  Effect.gen(function* () {
    for (const [reason, terminal] of [
      ["takeover", "yielded"],
      ["private", "hidden"],
    ] as const) {
      const events: string[] = [];
      const bridge = new ScreenHostBridge(
        new ScreenCursorPhases((event) => events.push(event.phase)),
      );
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () => Effect.succeed({ value: true, category: "confirmed", evidence: ["done"] }),
      });
      yield* bridge.handle(
        call(1),
        context(() => Effect.void),
      );
      yield* bridge.cutCell("r", "t", "c", reason);
      expect(events.at(-1)).toBe(terminal);
    }
  }),
);

it.effect("cell stop distinguishes in-flight writes from undispatched and future calls", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    let sent = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.gen(function* () {
          sent++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
        }),
    });
    const active = yield* bridge
      .handle(
        call(1),
        context(() => Effect.void),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const queued = yield* bridge
      .handle(
        call(2),
        context(() => Effect.void),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    bridge.cutCellNow("r", "t", "c");
    const first = yield* Fiber.join(active);
    const second = yield* Fiber.join(queued);
    const third = yield* bridge.handle(
      call(3),
      context(() => Effect.void),
    );
    expect(first?.error).toMatchObject({ safety: { possibleCommit: true, retryClass: "never" } });
    expect(second?.error).toMatchObject({
      safety: { possibleCommit: false, writeStatus: "not_started" },
    });
    expect(third?.error).toMatchObject({
      safety: { possibleCommit: false, writeStatus: "not_started" },
    });
    const collected = yield* bridge.takeCellImages("r", "t", "c");
    expect(collected.journal.map((entry) => entry.receipt.safety?.possibleCommit)).toEqual([
      true,
      false,
      false,
    ]);
    expect(sent).toBe(1);
  }),
);

it.effect("a call refused before anything was sent leaves the cell's later calls free to run", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let sent = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (request) =>
        request.callId === 1
          ? Effect.fail({
              code: "stale_reference" as const,
              effectStarted: false,
              nextStep: "Observe the current tab again.",
            })
          : Effect.sync(() => {
              sent++;
              return { category: "confirmed" as const, evidence: ["clicked"] };
            }),
    });
    const authorized = context(() => Effect.void);
    const waited = yield* bridge.handle({ ...call(1), method: "wait_for" }, authorized);
    expect(waited?.error).toMatchObject({ code: "stale_reference", effectStarted: false });
    // The bridge's own refusal sends nothing either.
    const foreign = { ...call(2), targetRef: { ...tab, environmentId: "elsewhere" } };
    expect((yield* bridge.handle(foreign, authorized))?.error?.code).toBe("stale_reference");
    expect((yield* bridge.handle(call(3), authorized))?.outcome).toBe("ok");
    expect(sent).toBe(1);
  }),
);

it.effect.each(["partial", "suspected_noop", "refused"] as const)(
  "a %s write stops its cell's later writes only when it may have landed, and the cell can still observe",
  (category) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The macOS driver's suspected no-op does not prove nothing landed, so it reads as unknown.
      const driverSafety =
        category === "suspected_noop"
          ? {
              safety: classifyActionOutcome({
                effect: "write",
                status: "indeterminate",
                dispatched: true,
              }),
            }
          : {};
      let sent = 0;
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (request) =>
          Effect.gen(function* () {
            sent++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { category, ...(request.method === "click" ? driverSafety : {}) };
          }),
      });
      const active = yield* bridge
        .handle(
          call(1),
          context(() => Effect.void),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const queued = yield* bridge
        .handle(
          call(2),
          context(() => Effect.void),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const first = yield* Fiber.join(active);
      const second = yield* Fiber.join(queued);
      const landed = category !== "refused";
      if (category === "suspected_noop") expect(first).toMatchObject({ outcome: "ok", category });
      else {
        expect(first?.outcome).toBe("error");
        expect(first?.error?.safety?.possibleCommit).toBe(landed);
      }
      // The guest caught the failure and went on: it may observe, and sends more input only when
      // the failed write cannot have changed the page.
      const observed = yield* bridge.handle(
        { ...call(3), method: "observe" },
        context(() => Effect.void),
      );
      expect(observed?.error?.code).not.toBe("not_run");
      const third = yield* bridge.handle(
        call(4),
        context(() => Effect.void),
      );
      for (const reply of [second, third])
        if (landed)
          expect(reply?.error).toMatchObject({
            code: "not_run",
            effectStarted: false,
            safety: { possibleCommit: false, retryClass: "new_key" },
          });
        else expect(reply?.error?.code).not.toBe("not_run");
      expect(sent).toBe(landed ? 2 : 4);
      const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
      const skipped = landed ? ["not_run:after_call:1"] : [];
      expect(journal.map((entry) => [entry.receipt.method, entry.receipt.evidence])).toEqual([
        [call(1).method, []],
        [call(2).method, skipped],
        ["observe", []],
        [call(4).method, skipped],
      ]);
    }),
);

it.effect("a host's unproven no-op is reported and stops the cell's later writes", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let sent = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          sent++;
          return { category: "suspected_noop" as const };
        }),
    });
    const first = yield* bridge.handle(
      call(1),
      context(() => Effect.void),
    );
    expect(first).toMatchObject({ outcome: "ok", category: "suspected_noop" });
    expect(
      (yield* bridge.handle(
        call(2),
        context(() => Effect.void),
      ))?.error?.code,
    ).toBe("not_run");
    expect(sent).toBe(1);
    const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
    expect(journal[0]?.receipt.safety).toMatchObject({
      possibleCommit: true,
      writeStatus: "may_have_applied",
    });
  }),
);

it.effect("a failure on one target keeps another target's in-flight call and its result", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (request) =>
        request.callId === 1
          ? Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { category: "confirmed" as const, evidence: ["readback"], value: "typed" };
            })
          : Effect.succeed({ category: "partial" as const }),
    });
    const other = { ...tab, id: "other" };
    const slow = yield* bridge
      .handle(
        call(1),
        context(() => Effect.void),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const failed = yield* bridge.handle(
      { ...call(2), targetRef: other },
      context(() => Effect.void),
    );
    yield* Deferred.succeed(release, undefined);
    expect(failed?.outcome).toBe("error");
    expect(yield* Fiber.join(slow)).toMatchObject({ outcome: "ok", value: "typed" });
  }),
);

it.effect("a confirmed write keeps its cell open and an output failure retains its commit", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: (request) =>
        Effect.succeed({
          category: "confirmed",
          evidence: ["driver:confirmed"],
          value: request.callId < 3 ? "ok" : "large".repeat(100),
        }),
    });
    const ctx = {
      ...context(() => Effect.void),
      limits: { ...context().limits, returnBytes: 100 },
    };
    expect((yield* bridge.handle(call(1), ctx))?.outcome).toBe("ok");
    expect((yield* bridge.handle(call(2), ctx))?.outcome).toBe("ok");
    expect((yield* bridge.handle(call(3), ctx))?.error?.safety).toMatchObject({
      possibleCommit: true,
      retryClass: "never",
    });
    expect((yield* bridge.handle(call(4), ctx))?.error?.safety?.possibleCommit).toBe(false);
  }),
);

it.effect(
  "a confirmed write without readback evidence is unverifiable, may have committed, and the cell goes on",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      let sent = 0;
      const committed = {
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "committed",
        code: "write_committed",
      } as const;
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (request) => {
          sent++;
          return Effect.succeed(
            request.callId === 1
              ? { category: "confirmed" as const }
              : { category: "confirmed" as const, safety: committed },
          );
        },
      });
      for (const callId of [1, 2])
        expect(
          (yield* bridge.handle(
            call(callId),
            context(() => Effect.void),
          ))?.outcome,
        ).toBe("ok");
      expect(sent).toBe(2);
      const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
      for (const entry of journal) {
        expect(entry.receipt.category).toBe("unverifiable");
        expect(entry.receipt.safety).toEqual({
          possibleCommit: true,
          retryClass: "never",
          writeStatus: "may_have_applied",
          code: "write_indeterminate",
        });
      }
    }),
);

it.effect(
  "tab input a deadline collects unsettled still reports dispatch and effect as unknown",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const started = yield* Deferred.make<void>();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* bridge
        .handle(
          call(1),
          context(() => Effect.void),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* bridge
        .handle(
          call(2),
          context(() => Effect.void),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      bridge.markUnawaitedNow("r", "t", "c", [1, 2]);
      const journal = bridge.takeCellImagesNow("r", "t", "c").journal;
      expect(journal.map((entry) => [entry.receipt.dispatched, entry.receipt.outcome])).toEqual([
        [true, { dispatch: "unknown", effect: "unknown" }],
        [false, { dispatch: "unknown", effect: "unknown" }],
      ]);
      bridge.cutCellNow("r", "t", "c");
    }),
);

const app = { ...tab, id: "window", kind: "app" as const };
const member = (callId: number, index: number, size: number, text = "a"): ScreenHostCall => ({
  ...call(callId),
  targetRef: app,
  method: "type_text",
  args: [{ text, batch: { index, size }, targetRef: app }],
});

it.effect("a batch group whose member is refused on admission sends none of the group", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let sent = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.sync(() => ({ category: "confirmed" as const })),
      dispatchBatch: (calls) =>
        Effect.sync(() => {
          sent += calls.length;
          return [];
        }),
    });
    const limits = { ...context(), limits: screenRunLimits({ argBytes: 4 }) };
    const replies = yield* Effect.forEach(
      [member(1, 0, 3), member(2, 1, 3, "too long"), member(3, 2, 3)],
      (each) => bridge.handle(each, limits),
      { concurrency: "unbounded" },
    );
    expect(
      replies.map((reply) => (reply && "error" in reply ? reply.error?.code : reply?.outcome)),
    ).toEqual(["not_run", "text_limit", "not_run"]);
    expect(sent).toBe(0);
  }),
);

it.effect(
  "a tab wait stuck behind its tab's other call, its authorization or an unanswering browser still answers inside its cell",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const holding = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const interrupted: string[] = [];
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (request) =>
          request.method === "click"
            ? Deferred.succeed(holding, undefined).pipe(
                Effect.andThen(Deferred.await(never)),
                Effect.as({ category: "confirmed" as const, evidence: ["clicked"] }),
              )
            : request.method === "observe"
              ? Effect.succeed({ category: "confirmed" as const, evidence: ["seen"] })
              : Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => interrupted.push(request.targetRef?.id ?? "")),
                  ),
                ),
      });
      const target = (id: string, kind: "tab" | "app" = "tab") => ({ ...tab, id, kind });
      const inCell = (
        cellId: string,
        callId: number,
        method: ScreenHostCall["method"],
        id: string,
        deadlineMillis: number,
        reauthorize: () => Effect.Effect<void> = () => Effect.void,
        kind: "tab" | "app" = "tab",
      ) =>
        bridge.handle(
          { ...call(callId), cellId, method, targetRef: target(id, kind), deadlineMillis },
          { ...context(reauthorize), cellId },
        );
      const receipt = (cellId: string) => bridge.takeCellImagesNow("r", "t", cellId);

      // Gate: another call on the same tab holds it, so the wait never reaches the host.
      const click = yield* inCell("gate", 1, "click", "a", 60_000).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(holding);
      const gated = yield* inCell("gate", 2, "wait_for", "a", 1_000).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("899 millis");
      expect(gated.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      // Answered at the boundary itself; a missing race fails here instead of hanging.
      expect(gated.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(gated))?.error).toMatchObject({
        code: "deadline",
        effectStarted: false,
      });
      expect(click.pollUnsafe()).toBeUndefined();
      const gateWait = receipt("gate").journal.find((entry) => entry.receipt.callId === 2);
      expect(gateWait?.receipt).toMatchObject({ dispatched: false, evidence: [] });

      // Authorization that never answers (the clock is at 900 ms now).
      const authorizing = yield* inCell("auth", 1, "wait_for", "b", 2_900, () => Effect.never).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1899 millis");
      expect(authorizing.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(authorizing.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(authorizing))?.error?.code).toBe("deadline");
      expect(receipt("auth").journal[0]?.receipt.dispatched).toBe(false);

      // A browser that never answers, when the broker's own timer has not fired (the clock is at 2,800 ms).
      const unanswered = yield* inCell("browser", 1, "wait_for", "c", 5_800).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("2899 millis");
      expect(unanswered.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(unanswered.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(unanswered))?.error).toMatchObject({
        code: "deadline",
        effectStarted: false,
      });
      expect(interrupted).toEqual(["c"]);
      // A read that failed does not stop the cell, and gives back its effect count.
      expect((yield* inCell("browser", 2, "observe", "c", 60_000))?.outcome).toBe("ok");
      const browser = receipt("browser");
      expect(browser.journal[0]?.receipt).toMatchObject({
        dispatched: false,
        evidence: ["wait_deadline:after_dispatch"],
      });
      expect(browser.effectsStarted).toBe(1);

      // An app wait keeps its own driver timing; the bridge does not race it.
      const appWait = yield* inCell(
        "app",
        1,
        "wait_for",
        "d",
        6_700,
        () => Effect.void,
        "app",
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2000 millis");
      expect(appWait.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(appWait);
      yield* Fiber.interrupt(click);
    }),
);

it.effect(
  "a pause before dispatch says nothing was sent; a pause after dispatch says it may have taken effect",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const started = yield* Deferred.make<void>();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const first = yield* bridge
        .handle({ ...call(1), targetRef: app }, context())
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const second = yield* bridge
        .handle({ ...call(2), targetRef: app }, context())
        .pipe(Effect.forkChild({ startImmediately: true }));
      bridge.cutCellNow("r", "t", "c", "pause");
      const dispatched = yield* Fiber.join(first);
      const queued = yield* Fiber.join(second);
      const third = yield* bridge.handle({ ...call(3), targetRef: app }, context());
      expect(dispatched?.error?.effectStarted).toBe(true);
      expect(dispatched?.error?.nextStep).toContain("may have taken effect");
      expect(dispatched?.error?.nextStep).not.toContain("nothing was sent");
      expect(queued?.error?.effectStarted).toBe(false);
      expect(queued?.error?.nextStep).toContain("nothing was sent");
      expect(third?.error?.effectStarted).toBe(false);
      expect(third?.error?.nextStep).toContain("nothing was sent");
    }),
);

it.effect(
  "cutting or discarding a failed cell settles its cursor to resting and keeps the target for the next cell",
  () =>
    Effect.gen(function* () {
      const events: Array<{ phase: string; generation: number }> = [];
      const bridge = new ScreenHostBridge(
        new ScreenCursorPhases((event) =>
          events.push({ phase: event.phase, generation: event.identity.generation }),
        ),
      );
      const started = yield* Deferred.make<void>();
      const releaseOld = yield* Deferred.make<void>();
      let calls = 0;
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          ++calls === 1
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOld)),
                Effect.as({ value: true, category: "confirmed" as const, evidence: ["done"] }),
              )
            : Effect.succeed({ value: true, category: "confirmed" as const, evidence: ["done"] }),
      });
      const live = context(() => Effect.void);
      const inFlight = yield* bridge
        .handle(call(1), live)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      bridge.cutCellNow("r", "t", "c");
      yield* Fiber.join(inFlight);
      yield* Deferred.succeed(releaseOld, undefined);
      expect(events.map((entry) => entry.phase)).toEqual(["thinking", "resting"]);

      // Next cell in the same turn reuses the same target and callId 1.
      const nextReply = yield* bridge.handle(
        { ...call(1), cellId: "c2" },
        { ...live, cellId: "c2" },
      );
      expect(nextReply?.outcome).toBe("ok");
      expect(events.map((entry) => entry.phase)).toEqual([
        "thinking",
        "resting",
        "thinking",
        "resting",
      ]);
      yield* bridge.finishTurn("r", "t");
      expect(events.at(-1)?.phase).toBe("hidden");
    }),
);

it.effect(
  "a missing preview capability hides only the tab while a failed session reauthorization hides all turn targets",
  () =>
    Effect.gen(function* () {
      const appRef = { ...tab, id: "app-1", kind: "app" as const, generation: 1 };
      const tabRef = { ...tab, id: "tab-1", kind: "tab" as const, generation: 1 };
      const events: Array<{ targetId: string; phase: string }> = [];
      const bridge = new ScreenHostBridge(
        new ScreenCursorPhases((event) =>
          events.push({ targetId: event.identity.targetId, phase: event.phase }),
        ),
      );
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.succeed({ value: true, category: "confirmed" as const, evidence: ["done"] }),
      });
      const noPreview = {
        ...context(() => Effect.void),
        invocation: {
          ...context(() => Effect.void).invocation,
          capabilities: new Set<never>(),
        },
      };
      yield* bridge.handle({ ...call(1), targetRef: appRef }, noPreview);
      const denied = yield* bridge.handle({ ...call(2), targetRef: tabRef }, noPreview);
      expect(denied && "error" in denied ? denied.error?.code : undefined).toBe(
        "permission_denied",
      );
      expect(events).toEqual([
        { targetId: "app-1", phase: "thinking" },
        { targetId: "app-1", phase: "resting" },
        { targetId: "tab-1", phase: "thinking" },
        { targetId: "tab-1", phase: "hidden" },
      ]);
      // In the next cell, the app remains usable while the denied tab is fenced as stale.
      const appNext = yield* bridge.handle(
        { ...call(1), cellId: "c2", targetRef: appRef },
        { ...noPreview, cellId: "c2" },
      );
      const tabNext = yield* bridge.handle(
        { ...call(2), cellId: "c2", targetRef: tabRef },
        { ...noPreview, cellId: "c2" },
      );
      expect(appNext?.outcome).toBe("ok");
      expect(tabNext && "error" in tabNext ? tabNext.error?.code : undefined).toBe(
        "stale_reference",
      );

      // Session-wide reauthorize failure hides and fences all targets touched in the turn.
      const revoked = context(() => Effect.fail("revoked" as never));
      const tabRevoked = yield* bridge.handle(
        { ...call(3), cellId: "c2", targetRef: { ...tabRef, id: "tab-2" } },
        { ...revoked, cellId: "c2" },
      );
      expect(tabRevoked && "error" in tabRevoked ? tabRevoked.error?.code : undefined).toBe(
        "permission_denied",
      );
      expect(events.filter((entry) => entry.targetId === "app-1").at(-1)?.phase).toBe("hidden");
    }),
);

it.effect(
  "holds a queued batch's phases behind the target gate and advances its generation after another window runs",
  () =>
    Effect.gen(function* () {
      const events: Array<{ targetId: string; generation: number; phase: string }> = [];
      const phases = new ScreenCursorPhases((event) =>
        events.push({
          targetId: event.identity.targetId,
          generation: event.identity.generation,
          phase: event.phase,
        }),
      );
      const bridge = new ScreenHostBridge(phases);
      const a1Started = yield* Deferred.make<void>();
      const releaseA1 = yield* Deferred.make<void>();
      const a1 = { ...tab, id: "win-a", kind: "app" as const, generation: 1 };
      const b1 = { ...tab, id: "win-b", kind: "app" as const, generation: 2 };
      const seenGenerations: number[] = [];
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (each) =>
          each.callId === 1
            ? Deferred.succeed(a1Started, undefined).pipe(
                Effect.andThen(Deferred.await(releaseA1)),
                Effect.as({ value: true, category: "confirmed" as const, evidence: ["ok"] }),
              )
            : Effect.sync(() => {
                if (each.targetRef)
                  seenGenerations.push(
                    phases.generationOf(each.targetRef, `${each.cellId}\u0000${each.callId}`),
                  );
                return { value: true, category: "confirmed" as const, evidence: ["ok"] };
              }),
      });
      const live = context(() => Effect.void);
      const f1 = yield* bridge
        .handle({ ...call(1), targetRef: a1 }, live)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(a1Started);
      // Queue a 2-call batch [2, 3] on win-a while call 1 still holds win-a's gate.
      const f2 = yield* bridge
        .handle({ ...call(2), targetRef: a1, args: [{ batch: { index: 0, size: 2 } }] }, live)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const f3 = yield* bridge
        .handle({ ...call(3), targetRef: a1, args: [{ batch: { index: 1, size: 2 } }] }, live)
        .pipe(Effect.forkChild({ startImmediately: true }));
      // Neither batch member starts a phase while call 1 holds win-a's gate.
      expect(events).toEqual([{ targetId: "win-a", generation: 1, phase: "thinking" }]);
      // Window B runs meanwhile at generation 2.
      yield* bridge.handle({ ...call(4), targetRef: b1 }, live);
      // Release call 1: the queued batch [2, 3] enters win-a's gate and bumps win-a to generation 3.
      yield* Deferred.succeed(releaseA1, undefined);
      yield* Fiber.joinAll([f1, f2, f3]);
      expect(seenGenerations).toEqual([2, 3, 3]);
      expect(events).toEqual([
        { targetId: "win-a", generation: 1, phase: "thinking" },
        { targetId: "win-b", generation: 2, phase: "thinking" },
        { targetId: "win-b", generation: 2, phase: "resting" },
        { targetId: "win-a", generation: 1, phase: "resting" },
        { targetId: "win-a", generation: 3, phase: "thinking" },
        { targetId: "win-a", generation: 3, phase: "resting" },
      ]);
    }),
);
