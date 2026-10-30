import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { NotStarted, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

it.live("verifyState advances the baseline and cannot imply a no-op for earlier input", () => {
  let reads = 0;
  const { host } = fixture({
    click: { effect: "unverifiable" },
    get_window_state: (args: Record<string, unknown>) => {
      const snapshot = `s${++reads}`;
      const old = goat2WindowState(args);
      const full = {
        ...old,
        snapshot_id: snapshot,
        elements:
          "elements" in old
            ? old.elements?.map((item) => ({
                ...item,
                element_token: `${snapshot}:${item.element_index}`,
              }))
            : undefined,
      };
      if (args.since === undefined) return full;
      const { tree_markdown: _tree, ...diff } = full;
      return { ...diff, since_status: "no_change", tree_diff: `no change since ${args.since}` };
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7}); await app.observe(); await app.click(1); const verified = await app.verifyState(); return await app.observe({mode:'diff', baseObservationId:verified.observationId});`,
    });
    expect(result.value).toMatchObject({ mode: "diff" });
    expect(result.value).not.toHaveProperty("effect");
    expect(
      result.journal.find((entry) => entry.receipt.method === "click")?.receipt.observedEffect,
    ).toBeUndefined();
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live.each(["batch", "refused"] as const)(
  "%s input keeps accurate observation receipts",
  (scenario) => {
    let reads = 0;
    const { host, sent } = fixture({
      click:
        scenario === "refused"
          ? new NotStarted({ refused: "targetRefused", detail: "target_busy" })
          : { effect: "unverifiable" },
      get_window_state: (args: Record<string, unknown>) => {
        const snapshot = `s${++reads}`;
        const old = goat2WindowState(args);
        const full = {
          ...old,
          snapshot_id: snapshot,
          tree_markdown:
            '- [0] AXWindow "Document"\n- [1] AXButton "Apply"\n- [2] AXButton "Other"',
          elements:
            "elements" in old
              ? [
                  ...(old.elements ?? []).map((item) => ({
                    ...item,
                    element_token: `${snapshot}:${item.element_index}`,
                  })),
                  {
                    element_index: 2,
                    element_token: `${snapshot}:2`,
                    role: "AXButton",
                    label: "Other",
                  },
                ]
              : undefined,
        };
        if (args.since === undefined) return full;
        const { tree_markdown: _tree, ...diff } = full;
        return { ...diff, since_status: "diff", tree_diff: '~ AXStaticText = "8"' };
      },
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7}); await app.observe(); ${scenario === "batch" ? "await Promise.all([app.click(1), app.click(2)]);" : "try { await app.click(1); } catch (e) { if (!e.nothingSent) throw e; }"} return await app.observe();`,
      });
      const clicks = result.journal.filter((entry) => entry.receipt.method === "click");
      if (scenario === "batch") {
        expect(clicks).toHaveLength(2);
        expect(clicks.map((entry) => entry.receipt.observedEffect)).toEqual(
          Array(2).fill({ state: "change_seen", rows: ['~ AXStaticText = "8"'] }),
        );
        expect(result.value).toMatchObject({
          effect: 'after 2 inputs: changed (~ AXStaticText = "8")',
        });
        expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(2);
      } else {
        expect(clicks).toHaveLength(1);
        expect(clicks[0]?.receipt).toMatchObject({ category: "refused", dispatched: false });
        expect(clicks[0]?.receipt.observedEffect).toBeUndefined();
        expect(result.value).not.toHaveProperty("effect");
      }
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);
