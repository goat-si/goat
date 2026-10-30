import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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

/** Runs the cells in order, in one turn. */
const runCells = (
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
          yield* service.runCell({
            runId: "r",
            turnId: "t",
            threadId: "thread",
            environmentId: "env",
            invocation,
            source,
          }),
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
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([tab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      operations.push(request.operation);
      // The browser gave up waiting on the click after it may have landed.
      if (request.operation === "click")
        return Effect.fail(new PreviewAutomationTimeoutError(actionErrorContext));
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
  "after a click's outcome is lost, the same cell still observes the page, and never clicks twice",
  () => {
    const { broker, operations } = savingTab();
    return runCells(broker, [
      `const tab = await screen.tab('form');
      await tab.claim();
      await tab.observe();
      try { await tab.click(0); } catch (error) { screen.state.lost = error.code; }
      try { await tab.click(0); } catch (error) { screen.state.again = error.code; }
      const after = await tab.observe({ diff: false });
      return { lost: screen.state.lost, again: screen.state.again, text: after.text };`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result?.value).toEqual({
          lost: "unknown_outcome",
          again: "not_run",
          text: "- button Save [0]",
        });
        expect(
          result?.journal.find((entry) => entry.receipt.method === "click")?.receipt,
        ).toMatchObject({
          category: "unknown_outcome",
          outcome: { dispatch: "unknown", effect: "unknown" },
        });
        expect(operations.filter((operation) => operation === "click")).toHaveLength(1);
      }),
    );
  },
);
