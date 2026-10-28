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
import { actionErrorContext } from "./PreviewTargetHost.testkit.ts";
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

it.live("a tab wait takes its timeout as a number or as options", () => {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("page"),
    title: "Page",
    url: "https://example.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const waits: Array<number | undefined> = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([tab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "waitFor") {
        waits.push(request.timeoutMs);
        return Effect.fail(
          new PreviewAutomationTimeoutError({ ...actionErrorContext, operation: "waitFor" }),
        );
      }
      return Effect.succeed({
        tabId: tab.tabId,
        url: tab.url,
        control: { owner: "unclaimed", generation: 0 },
      } as A);
    },
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
        source: `const tab = await screen.tab({tabId: 'page'});
          const positional = await tab.waitFor({text: 'Missing'}, 300);
          const options = await tab.waitFor({text: 'Missing'}, {timeoutMs: 400});
          return [positional.met, options.met];`,
      });
      expect(result).toMatchObject({ status: "completed", value: [false, false] });
      expect(waits).toEqual([300, 400]);
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

const formTab = {
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

it.live("a tab target can be bound again in a later cell by its identity or tabId", () => {
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>() =>
      Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "unclaimed", generation: 0 },
      } as A),
  };
  return runCells(broker, [
    `const tab = await screen.tab({tabId: 'form'});
     screen.values.identity = tab.identity;
     return { identity: tab.identity, tabId: tab.tabId };`,
    `const again = await screen.tab({identity: screen.values.identity});
     const byId = await screen.tab({tabId: again.tabId});
     return [again.tabId, byId.tabId];`,
  ]).pipe(
    Effect.map(([first, second]) => {
      expect(first).toMatchObject({ _tag: "Success", success: { status: "completed" } });
      const bound = first?._tag === "Success" ? (first.success.value as { tabId?: string }) : {};
      expect(bound.tabId).toBe("form");
      expect(second).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: ["form", "form"] },
      });
    }),
  );
});

it.live("waitFor with a role and name on a tab waits for that element", () => {
  const waits: unknown[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "waitFor") waits.push(request.input);
      return Effect.succeed(
        (request.operation === "waitFor"
          ? { status: "met" }
          : {
              tabId: formTab.tabId,
              url: formTab.url,
              control: { owner: "unclaimed", generation: 0 },
            }) as A,
      );
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab({tabId: 'form'});
     return (await tab.waitFor({role: 'textbox', name: 'Customer name:'}, 500)).met;`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: true },
      });
      expect(waits).toEqual([
        expect.objectContaining({ locator: 'role=textbox[name="Customer name:" s]' }),
      ]);
    }),
  );
});
