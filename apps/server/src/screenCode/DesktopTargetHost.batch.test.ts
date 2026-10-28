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
  failed_step: reports.some((report) => report.ok === false) ? reports.length - 1 : null,
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
    const result = yield* runCell(
      `${BIND} ${clicks(3)} const settled = await Promise.allSettled(clicks); return settled.map((r) => r.status === 'fulfilled' ? r.value.verdict : [r.reason.code, r.reason.nothingSent, r.reason.evidence ?? []]);`,
    );
    // The refused step keeps the driver's own effect and code beside GOAT's error code.
    const said = ["driver:effect=refused", "driver:code=outside_scope"];
    expect(result.value).toEqual([
      "confirmed",
      ["permission_denied", true, said],
      ["not_run", true, []],
    ]);
    const refused = result.journal.find((entry) => entry.receipt.category === "refused");
    expect(refused?.receipt.evidence).toEqual(expect.arrayContaining(said));
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});

it.live.each([
  ["a reply cut to its message", { message: "Driver reply exceeded the primitive channel limit." }],
  // It ran three steps but reports one, with no failure to say where it stopped.
  [
    "fewer step reports than it ran",
    { ...ranSteps([{ ok: true, effect: "confirmed" }], 3), executed: 3 },
  ],
] as const)("%s leaves every click possibly run", ([, answer]) => {
  const { host } = fixture({ run_steps: answer });
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
  const { host, sent } = fixture({
    run_steps: (args: { steps: ReadonlyArray<unknown> }) =>
      ranSteps(
        args.steps.map(() => ({ ok: true, effect: "confirmed" })),
        args.steps.length,
      ),
  });
  return Effect.gen(function* () {
    // Seventeen is one group of sixteen and one more click, under a limit of four pending calls.
    const result = yield* runCell(`${BIND} ${clicks(17)} ${SETTLED}`);
    expect(result.value).toEqual(Array.from({ length: 17 }, () => "confirmed"));
    expect(sent.map((entry) => entry.tool).slice(3)).toEqual(["run_steps", "click"]);
    yield* finish;
  }).pipe(Effect.provide(cellService(host)));
});
