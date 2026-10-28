import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, DriverError, fixture, NotStarted } from "./DesktopTargetHost.testkit.ts";

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
/** A run_steps answer: each step's report as the driver gives it (cua-driver-core batch_tools.rs). */
const ranSteps = (reports: ReadonlyArray<Record<string, unknown>>, total: number) => ({
  ok: reports.every((report) => report.ok !== false),
  total,
  executed: reports.length,
  steps: reports.map((report, index) => ({ index, tool: "click", ...report })),
});

it.live("eight unawaited element clicks on one window reach the driver as one run_steps", () => {
  const { host, sent } = fixture({
    run_steps: (args: { steps: ReadonlyArray<unknown> }) =>
      ranSteps(
        args.steps.map((_, index) => ({
          ok: true,
          effect: index === args.steps.length - 1 ? "confirmed" : "unverifiable",
        })),
        args.steps.length,
      ),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(`${BIND} ${clicks(8)} ${SETTLED}`);
    expect(result.value).toEqual([...Array.from({ length: 7 }, () => "unverifiable"), "confirmed"]);
    // Before batching each click was its own driver call: eight round trips; now one.
    expect(sent.map((entry) => entry.tool)).toEqual([
      "list_apps",
      "list_windows",
      "get_window_state",
      "run_steps",
    ]);
    const step = {
      tool: "click",
      args: { pid: 42, window_id: 7, element_token: "snapshot:1", delivery_mode: "background" },
    };
    expect(sent[3]?.args).toEqual({
      pid: 42,
      window_id: 7,
      verify: "checkpoint",
      app_scope: { apps: ["org.example.Editor"], delivery: "background" },
      steps: Array.from({ length: 8 }, () => step),
    });
    // Each click keeps its own receipt.
    expect(result.journal.filter((entry) => entry.receipt.method === "click")).toHaveLength(8);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a refused step stops the batch, and the cell sees which clicks ran", () => {
  const { host } = fixture({
    run_steps: new DriverError(
      ranSteps(
        [
          { ok: true, effect: "confirmed" },
          {
            ok: false,
            effect: "refused",
            code: "outside_scope",
            message: "click: refused by the batch scope",
          },
        ],
        3,
      ),
    ),
  });
  return Effect.gen(function* () {
    const result = yield* runCell(`${BIND} ${clicks(3)} ${SETTLED}`);
    expect(result.value).toEqual(["confirmed", "permission_denied:true", "not_run:true"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live("a reply that does not account for its steps leaves every click possibly run", () => {
  const { host } = fixture({
    run_steps: { message: "Driver reply exceeded the primitive channel limit." },
  });
  return Effect.gen(function* () {
    const result = yield* runCell(`${BIND} ${clicks(3)} ${SETTLED}`);
    const value = result.value as ReadonlyArray<string>;
    expect(value).toHaveLength(3);
    // None of them may be reported as not sent.
    for (const settled of value) expect(settled).toMatch(/:false$/);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "a driver whose run_steps takes no app_scope gets the clicks one at a time, and is not asked again",
  () => {
    const { host, sent } = fixture({
      run_steps: new NotStarted({ refused: "targetRefused", detail: "outside_manifest" }),
    });
    return Effect.gen(function* () {
      const first = yield* runCell(`${BIND} ${clicks(2)} ${SETTLED}`);
      expect(first.value).toEqual(["confirmed", "confirmed"]);
      const second = yield* runCell(`${BIND} ${clicks(2)} ${SETTLED}`);
      expect(second.value).toEqual(["confirmed", "confirmed"]);
      expect(sent.map((entry) => entry.tool).filter((tool) => tool !== "get_window_state")).toEqual(
        [
          "list_apps",
          "list_windows",
          "run_steps",
          "click",
          "click",
          "list_apps",
          "list_windows",
          "click",
          "click",
        ],
      );
      yield* finish;
    }).pipe(Effect.provide(cellService(host)));
  },
);
