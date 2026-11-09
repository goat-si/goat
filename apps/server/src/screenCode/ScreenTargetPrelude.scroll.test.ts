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
import { context as desktopContext, fixture } from "./DesktopTargetHost.testkit.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const refusal = [
  "invalid_argument",
  true,
  "scroll amount must be an integer from 1 to 50; nothing was sent.",
];
const runtime = {
  command: process.execPath,
  entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
};

it.live(
  "app scroll refuses an amount outside whole numbers 1 to 50 before reading or sending, and sends a valid or default amount once",
  () => {
    const { host, sent } = fixture();
    return Effect.gen(function* () {
      const result = yield* (yield* ScreenRunService).runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: desktopContext.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        const refused = [];
        for (const [target, amount] of [
          [0, {amount: 5}], [0, null], [0, 0], [0, -1], [0, 1.5], [0, '5'], [0, NaN], [0, 51],
          ['Apply', [5]], [null, 0],
        ]) {
          try { await app.scroll(target, 'up', amount); refused.push('sent'); }
          catch (e) { refused.push([e.code, e.nothingSent, e.message]); }
        }
        await app.observe();
        await app.scroll(0, 'up', 5);
        await app.scroll(0, 'up');
        return refused;`,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: Array.from({ length: 10 }, () => refusal),
      });
      const calls = sent.filter(
        (entry) => !["list_apps", "list_windows", "bind_app"].includes(entry.tool),
      );
      expect(calls.map((entry) => entry.tool)).toEqual(["get_window_state", "scroll", "scroll"]);
      expect(calls[1]?.args).toMatchObject({ direction: "up", amount: 5 });
      expect(calls[2]?.args).toMatchObject({ direction: "up", amount: 3 });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          desktopHost: host,
          invocation: runtime,
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

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
const tabInvocation = {
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
  "tab scroll refuses an amount outside whole numbers 1 to 50 without input and keeps 100 pixels per step",
  () => {
    const scrolls: unknown[] = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([formTab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "scroll") scrolls.push(request.input);
        return Effect.succeed({
          tabId: formTab.tabId,
          url: formTab.url,
          title: formTab.title,
          loading: false,
          refGeneration: "1",
          control: { owner: "agent", ownedByCaller: true, generation: 0 },
        } as A);
      },
    };
    return Effect.gen(function* () {
      const tabHost = yield* makePreviewTargetHost(broker);
      return yield* Effect.gen(function* () {
        const result = yield* (yield* ScreenRunService).runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: tabInvocation,
          source: `const tab = await screen.tab({tabId: 'form'});
          await tab.claim();
          const refused = [];
          for (const amount of [null, 0, 2.5, '2', 51]) {
            try { await tab.scroll(null, 'down', amount); refused.push('sent'); }
            catch (e) { refused.push([e.code, e.nothingSent, e.message]); }
          }
          await tab.scroll(null, 'down', 2);
          await tab.scroll(null, 'left');
          await tab.scroll(null, 'up', 50);
          await tab.scroll({deltaY: 120});
          return refused;`,
        });
        expect(result).toMatchObject({
          status: "completed",
          value: Array.from({ length: 5 }, () => refusal),
        });
        expect(scrolls).toEqual([
          { deltaX: 0, deltaY: 200 },
          { deltaX: -300, deltaY: 0 },
          { deltaX: 0, deltaY: -5000 },
          { deltaX: 0, deltaY: 120 },
        ]);
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher: createScreenDispatchRouter({ tab: tabHost }),
            tabHost,
            invocation: runtime,
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    });
  },
);
