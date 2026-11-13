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

export const invocation = {
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

/** Runs each cell in order through the real screen runtime against a stub browser broker. */
export const runCells = (
  broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs">,
  sources: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const results = [];
      for (const source of sources)
        results.push(
          yield* service
            .runCell({
              runId: "r",
              turnId: "t",
              threadId: "thread",
              environmentId: "env",
              invocation,
              source,
            })
            .pipe(Effect.result),
        );
      return results;
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

export const formTab = {
  environmentId: "env",
  browserInstanceId: "server-browser",
  connectionId: "connection",
  threadId: "thread",
  tabId: PreviewTabId.make("form"),
  title: "Form",
  url: "https://httpbin.test/forms/post",
  owner: "unclaimed" as const,
  ownedByCaller: false,
  controlGeneration: 0,
};
