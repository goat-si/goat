import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import { context, fixture } from "./DesktopTargetHost.testkit.ts";

it.live(
  "screen.menuBarExtras refuses before dispatch with unsupported and nothingSent while 030 §3.13 driver tools are not yet pinned",
  () => {
    const base = fixture({});
    const leases = {
      currentControl: () => Effect.succeedSome({ controlId: "control" }),
      controlState: () =>
        Effect.succeed({
          _tag: "active" as const,
          idle: false,
          apps: ["com.knollsoft.Rectangle"],
        }),
      releaseForeground: () => Effect.succeed(true),
    };
    const host = createDesktopTargetHost({
      primitiveChannel: base.channel as never,
      leases: leases as never,
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `let caught;
          try { await screen.menuBarExtras(); }
          catch (e) { caught = { code: e.code, nothingSent: e.nothingSent, message: e.message }; }
          return caught;`,
      });
      expect(result.status).toBe("completed");
      expect(result.value).toEqual({
        code: "unsupported",
        nothingSent: true,
        message:
          "Menu bar extras are unavailable until the 030 §3.13 driver update is pinned; bind an app window with screen.app() or hand the status item to the person.",
      });
      expect(base.sent).toEqual([]);
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
