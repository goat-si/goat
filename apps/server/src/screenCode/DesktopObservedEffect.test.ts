import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

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
