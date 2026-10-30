import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";
import { fixture, context } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

it.live("app targets refuse tab methods without sending input", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor',window_id:7});
        const result = [];
        for (const f of [() => app.logs(), () => app.evaluate('1'), () => app.dialog('dismiss'), () => app.upload('#f', [])]) {
          try { await f(); } catch (e) { result.push([e.code, e.nothingSent]); }
        }
        return result;`,
    });
    expect(result).toMatchObject({
      status: "completed",
      value: Array.from({ length: 4 }, () => ["unsupported", true]),
    });
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
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
