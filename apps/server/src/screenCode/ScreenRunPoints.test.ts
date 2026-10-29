import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewTabId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const invocation = {
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
  reauthorize: () => Effect.void,
};

it.live("a cell drags between two screenshot points and wheels at one, for a map", () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("map"),
    title: "Map",
    url: "https://map.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const inputs: Array<[string, unknown]> = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([tab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "drag" || request.operation === "scroll")
          inputs.push([request.operation, request.input]);
        return (
          request.operation === "status"
            ? { tabId: tab.tabId, url: tab.url, control: { owner: "unclaimed", generation: 0 } }
            : request.operation === "snapshot"
              ? {
                  url: tab.url,
                  title: "Map",
                  loading: false,
                  accessibilityTree: "- region Map",
                  treeComplete: true,
                  refGeneration: "1",
                  screenshot: {
                    mimeType: "image/png",
                    data: "AQID",
                    width: 200,
                    height: 100,
                    region: { kind: "viewport", x: 0, y: 0, width: 400, height: 200 },
                    scale: 0.5,
                  },
                }
              : {}
        ) as A;
      }),
  };
  return Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source: `const tab = await screen.tab({tabId: 'map'});
          await tab.claim();
          await tab.observe({screenshot: true});
          await tab.drag([10, 10], [60, 30]);
          await tab.observe({screenshot: true});
          await tab.scroll([50, 50], "up", 2);
          return true;`,
      });
      expect(result.status).toBe("completed");
      expect(inputs).toEqual([
        ["drag", { from: { x: 20, y: 20 }, to: { x: 120, y: 60 } }],
        ["scroll", { x: 100, y: 100, deltaX: 0, deltaY: -200 }],
      ]);
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ tab: tabHost }),
          tabHost,
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  });
});

it.live(
  "after a tab scroll an old screenshot point is refused as stale, a new screenshot works, and a wait names enabled",
  () => {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("lab"),
      title: "CU Lab",
      url: "https://lab.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const inputs: Array<[string, unknown]> = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          if (["click", "scroll", "waitFor"].includes(request.operation))
            inputs.push([request.operation, request.input]);
          return (
            request.operation === "status"
              ? { tabId: tab.tabId, url: tab.url, control: { owner: "unclaimed", generation: 0 } }
              : request.operation === "snapshot"
                ? {
                    url: tab.url,
                    title: "CU Lab",
                    loading: false,
                    accessibilityTree: "- button Continue [ref=e1]",
                    treeComplete: true,
                    refGeneration: "1",
                    screenshot: {
                      mimeType: "image/png",
                      data: "AQID",
                      width: 200,
                      height: 100,
                      region: { kind: "viewport", x: 0, y: 0, width: 200, height: 100 },
                      scale: 1,
                    },
                  }
                : {}
          ) as A;
        }),
    };
    return Effect.gen(function* () {
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        const result = yield* service.runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation,
          source: `const tab = await screen.tab({tabId: 'lab'});
          await tab.claim();
          await tab.observe({screenshot: true});
          await tab.scroll(null, "down", 2);
          let stale;
          try { await tab.click([10, 10]); } catch (error) { stale = [error.code, error.message, error.nothingSent]; }
          await tab.observe({screenshot: true});
          await tab.click([10, 10]);
          await tab.waitFor({ role: 'button', name: 'Continue', enabled: true }, 300);
          return stale;`,
        });
        expect(result).toMatchObject({
          status: "completed",
          value: [
            "stale_reference",
            "The page scrolled or changed since that screenshot. Observe({screenshot:true}) again.",
            true,
          ],
        });
        expect(inputs.map(([operation]) => operation)).toEqual(["scroll", "click", "waitFor"]);
        expect(inputs[2]?.[1]).toMatchObject({
          locator: 'role=button[name="Continue" s]',
          enabled: true,
        });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher: createScreenDispatchRouter({ tab: tabHost }),
            tabHost,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    });
  },
);
