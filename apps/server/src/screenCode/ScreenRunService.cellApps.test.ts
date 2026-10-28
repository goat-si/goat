import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnItemId, type EnvironmentId, type ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";

import { ComputerUseCallApps, makeCallApps } from "../cua/ComputerUseCallApps.ts";
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

it.live(
  "a finished cell's row names the target it acted on even when its provider keeps a summary",
  () => {
    const callApps = makeCallApps();
    const source =
      "const tab = await screen.tab({tabId: 'tab'}); await tab.observe(); return true;";
    callApps.screenTarget("target", { kind: "tab", pageUrl: "https://example.test/" });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "run",
        turnId: "turn",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source,
      });
      expect(result.value).toBe(true);
      const row = callApps.present({
        id: TurnItemId.make("cell-row"),
        type: "dynamic_tool",
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        toolName: "goat.goat_screen_run",
        input: { code: source },
        output: "Ran the screen cell.",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
      });
      expect(row.toolIcon).toEqual({ _tag: "website", pageUrl: "https://example.test/" });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
          dispatcher: {
            availability: () => Effect.succeed([{ kind: "tab", available: true }]),
            dispatch: (call) =>
              Effect.succeed(
                call.method === "select_tab"
                  ? {
                      value: {
                        targetRef: {
                          id: "target",
                          kind: "tab" as const,
                          environmentId: "env",
                          runId: "run",
                          turnId: "turn",
                          generation: 0,
                        },
                        tab: { tabId: "tab", title: "Page", url: "https://example.test/" },
                      },
                      category: "confirmed" as const,
                    }
                  : { value: { indexedText: "Page" }, category: "confirmed" as const },
              ),
          },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.provideService(ComputerUseCallApps, callApps),
    );
  },
);
