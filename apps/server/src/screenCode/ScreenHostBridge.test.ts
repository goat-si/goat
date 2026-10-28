import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
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
  deadlineMillis: 1,
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
        const image: ScreenImage = { ...metadata, bytes: Buffer.from("1234").toString("base64") };
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

it.effect.each(["partial", "suspected_noop", "refused"] as const)(
  "a %s write stops its cell's later writes, and the cell can still observe what it did",
  (category) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let sent = 0;
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.gen(function* () {
            sent++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { category };
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
      expect(first?.outcome).toBe("error");
      expect(first?.error?.safety?.possibleCommit).toBe(category === "partial");
      // The guest caught the failure and went on: it may observe, but sends no more input.
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
        expect(reply?.error).toMatchObject({
          code: "not_run",
          effectStarted: false,
          safety: { possibleCommit: false, retryClass: "new_key" },
        });
      expect(sent).toBe(2);
      const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
      expect(journal.map((entry) => [entry.receipt.method, entry.receipt.evidence])).toEqual([
        [call(1).method, []],
        [call(2).method, ["not_run:after_call:1"]],
        ["observe", []],
        [call(4).method, ["not_run:after_call:1"]],
      ]);
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
          : Effect.succeed({ category: "suspected_noop" as const }),
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
    expect(
      (yield* bridge.handle(
        call(3),
        context(() => Effect.void),
      ))?.error?.code,
    ).toBe("not_run");
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
