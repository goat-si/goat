import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

it.live("an element handle from an earlier full read is refused without input", () => {
  let reads = 0;
  const { host, sent } = fixture({
    get_window_state: () => {
      const snapshot = `s${++reads}`;
      const names =
        reads === 1 ? ["Document", "Original"] : ["Document", "Replacement", "Original"];
      const elements = names.map((label, index) => ({
        element_index: index,
        element_token: `${snapshot}:${index}`,
        role: index === 0 ? "AXWindow" : "AXButton",
        label,
      }));
      return {
        pid: 42,
        window_id: 7,
        snapshot_id: snapshot,
        elements_complete: false,
        elements,
        tree_markdown: elements
          .map((e) => `- [${e.element_index}] ${e.role} "${e.label}"`)
          .join("\n"),
      };
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
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const first = await app.observe(); const held = first.ref(1);
        await app.observe({diff:false});
        try { await app.click(held); return 'sent'; } catch (e) { return [e.code, e.nothingSent]; }`,
    });
    expect(result).toMatchObject({ status: "completed", value: ["stale_reference", true] });
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(0);
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

it.live("a fresh element handle dispatches its original element", () => {
  const { host, sent } = fixture({ get_window_state: goat2WindowState });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const obs = await app.observe(); const held = obs.ref(1);
        await app.click(held); return [Object.isFrozen(held), Object.keys(obs).includes('ref')];`,
    });
    expect(result).toMatchObject({ status: "completed", value: [true, false] });
    expect(sent.filter((entry) => entry.tool === "click")).toMatchObject([
      { args: { element_token: "s0000000a:1" } },
    ]);
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
