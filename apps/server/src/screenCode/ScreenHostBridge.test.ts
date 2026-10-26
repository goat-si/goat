import { expect, it } from "@effect/vitest";
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
      call(1),
      context(() => Effect.void),
    );
    const two = yield* bridge.handle(
      call(2),
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
    expect((yield* bridge.takeCellImages("r", "t", "c")).journal).toHaveLength(0);
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
