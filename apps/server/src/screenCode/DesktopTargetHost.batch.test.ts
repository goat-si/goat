import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { ComputerUsePrimitiveRequest } from "@goat/contracts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

const cellService = (host: ReturnType<typeof fixture>["host"]) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer));

const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
const runCell = (source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({ ...turn, invocation: context.invocation, source });
  });
const finish = Effect.gen(function* () {
  const service = yield* ScreenRunService;
  yield* service.finishTurn({ ...turn, reason: "test" });
});

const BIND =
  "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.observe();";
/** Each settled click as its verdict, or its error code and whether nothing was sent. */
const SETTLED =
  "return (await Promise.allSettled(clicks)).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);";
const clicks = (count: number) =>
  `const clicks = Array.from({ length: ${count} }, () => app.click('Apply'));`;
// Until the driver bounds each run_steps step by its own deadline, a group's element input goes
// one call at a time, so one call that never answers costs only its own cap.
it.live("eight unawaited element clicks on one window reach the driver one at a time", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const result = yield* runCell(`${BIND} ${clicks(8)} ${SETTLED}`);
    expect(result.value).toEqual(Array.from({ length: 8 }, () => "confirmed"));
    expect(sent.map((entry) => entry.tool)).toEqual([
      "list_apps",
      "list_windows",
      "get_window_state",
      ...Array.from({ length: 8 }, () => "click"),
    ]);
    expect(result.journal.filter((entry) => entry.receipt.method === "click")).toHaveLength(8);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "element typing started together past the primitive args cap goes one call at a time",
  () => {
    const { host, sent } = fixture();
    // What the lease stream encodes for each call; it rejects args over the primitive cap.
    const primitive = Schema.decodeUnknownSync(ComputerUsePrimitiveRequest);
    return Effect.gen(function* () {
      // Each typing is within the cell's own limit; together they are past the channel's.
      const result = yield* runCell(
        `${BIND} const clicks = [app.type('x'.repeat(33000), 'Apply'), app.type('y'.repeat(33000), 'Apply')]; ${SETTLED}`,
      );
      expect(result.value).toEqual(["confirmed", "confirmed"]);
      expect(sent.map((entry) => entry.tool).slice(3)).toEqual(["type_text", "type_text"]);
      for (const [callId, entry] of sent.entries())
        expect(() =>
          primitive({
            state: "primitive-request",
            requestId: "request",
            registrationId: "registration",
            controlId: "control",
            connectionGeneration: "driver:1",
            runId: "r",
            turnId: "t",
            callId,
            deadlineMillis: 1000,
            tool: entry.tool,
            args: entry.args,
          }),
        ).not.toThrow();
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("a refused click stops the group, and the cell sees which clicks ran", () => {
  let clicked = 0;
  const { host, sent } = fixture({
    click: () =>
      ++clicked === 1
        ? { effect: "confirmed", evidence: ["driver:acted"] }
        : new DriverError({
            effect: "refused",
            code: "outside_scope",
            message: "click: refused by the scope",
          }),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${BIND} ${clicks(3)} const settled = await Promise.allSettled(clicks); return settled.map((r) => r.status === 'fulfilled' ? r.value.verdict : [r.reason.code, r.reason.nothingSent]);`,
    );
    expect(result.value).toEqual(["confirmed", ["permission_denied", true], ["not_run", true]]);
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "a group the runtime cannot take whole is refused whole, without waiting for its deadline",
  () => {
    const { host, sent } = fixture();
    return Effect.gen(function* () {
      // The second typing is past the runtime's argument limit, so none of the group goes out.
      const result = yield* runCell(
        `${BIND} const clicks = [app.type('a', 'Apply'), app.type('x'.repeat(66000), 'Apply')]; ${SETTLED}`,
      );
      expect(result.status).toBe("completed");
      expect(result.value).toEqual(["refused:true", "refused:true"]);
      expect(sent.map((entry) => entry.tool)).toEqual([
        "list_apps",
        "list_windows",
        "get_window_state",
      ]);
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.live("a batch group takes one pending place, so a run longer than one group still runs", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    // Seventeen is one group of sixteen and one more click, under a limit of four pending calls.
    const result = yield* runCell(`${BIND} ${clicks(17)} ${SETTLED}`);
    expect(result.value).toEqual(Array.from({ length: 17 }, () => "confirmed"));
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(17);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a refused group sends nothing and, like any refusal, leaves the cell free", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    // Sixteen calls make one group, refused whole for its oversized typing; the seventeenth goes
    // alone, and so does a call the cell makes after it caught the refusal.
    const result = yield* runCell(
      `${BIND} const clicks = [app.type('x'.repeat(66000), 'Apply'), ...Array.from({ length: 16 }, () => app.click('Apply'))];
      const settled = (await Promise.allSettled(clicks)).map((r) => r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);
      const after = (await app.click('Apply')).verdict;
      return { settled, after };`,
    );
    expect(result.value).toEqual({
      settled: [...Array.from({ length: 16 }, () => "refused:true"), "confirmed"],
      after: "confirmed",
    });
    expect(sent.map((entry) => entry.tool).filter((tool) => tool === "click")).toEqual([
      "click",
      "click",
    ]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});
