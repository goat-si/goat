import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationTimeoutError,
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
import { actionErrorContext } from "./PreviewTargetHost.testkit.ts";

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

const runCell = (
  broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs">,
  source: string,
) =>
  Effect.gen(function* () {
    const tabHost = yield* makePreviewTargetHost(broker);
    return yield* Effect.gen(function* () {
      const service = yield* ScreenRunService;
      return yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation,
        source,
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

const savingTab = () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("form"),
    title: "Form",
    url: "https://form.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const operations: string[] = [];
  let connectionId = "connection";
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([{ ...tab, connectionId }]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      operations.push(request.operation);
      // As the broker does, a route to a connection it dropped finds no host.
      if (request.exact && request.exact.connectionId !== connectionId)
        return Effect.fail(
          new PreviewAutomationNoAvailableHostError({
            operation: request.operation,
            environmentId: actionErrorContext.environmentId,
            threadId: actionErrorContext.threadId,
            providerSessionId: actionErrorContext.providerSessionId,
            providerInstanceId: actionErrorContext.providerInstanceId,
          }),
        );
      // The click lands, but its reply is lost: the broker drops the host, which reconnects.
      if (request.operation === "click") {
        connectionId = "connection-2";
        return Effect.fail(new PreviewAutomationTimeoutError(actionErrorContext));
      }
      return Effect.succeed(
        (request.operation === "status"
          ? { tabId: tab.tabId, url: tab.url, control: { owner: "unclaimed", generation: 0 } }
          : request.operation === "snapshot"
            ? {
                url: tab.url,
                title: "Form",
                loading: false,
                accessibilityTree: "- button Save [ref=e1]",
                treeComplete: true,
                refGeneration: "1",
              }
            : {}) as A,
      );
    },
  };
  return { broker, operations };
};

it.live(
  "after a click's reply is lost and its host reconnects, the same cell still observes the page",
  () => {
    const { broker, operations } = savingTab();
    return runCell(
      broker,
      `const tab = await screen.tab('form');
      await tab.claim();
      const page = await tab.observe();
      try { await tab.click(page.elements[0].index); } catch (error) { screen.state.lost = error.code; }
      const after = await tab.observe({ diff: false });
      return { lost: screen.state.lost, elements: after.elements.length };`,
    ).pipe(
      Effect.map((result) => {
        expect(result.value).toEqual({ lost: "unknown_outcome", elements: 1 });
        expect(
          result.journal.find((entry) => entry.receipt.method === "click")?.receipt,
        ).toMatchObject({
          category: "unknown_outcome",
          outcome: { dispatch: "unknown", effect: "unknown" },
        });
        expect(operations.filter((operation) => operation === "click")).toHaveLength(1);
      }),
    );
  },
);
