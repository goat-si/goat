import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewAutomationExecutionError,
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
import { actionErrorContext, browserFixture } from "./PreviewTargetHost.testkit.ts";
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

it.effect("failed tab inputs retire observed refs while failed logs preserve them", () =>
  Effect.gen(function* () {
    for (const [method, args] of [
      ["tab_evaluate", { expression: "1" }],
      ["tab_dialog", { action: "accept" }],
      ["tab_upload", { selector: "#file", files: ["/tmp/example.txt"] }],
      ["tab_fill_secret", { secretRef: "ref", selector: "#password" }],
      ["tab_logs", {}],
    ] as const) {
      const fixture = yield* browserFixture(true);
      const ref = (yield* fixture.observe()).elements[0]!.ref;
      fixture.state.failure = new PreviewAutomationTimeoutError(actionErrorContext);
      expect((yield* fixture.dispatch(method, args))?.outcome).toBe("error");
      fixture.state.failure = undefined;
      const click = yield* fixture.dispatch("click", { ref });
      if (method === "tab_logs") expect(click?.outcome).toBe("ok");
      else {
        expect(click?.error?.code).toBe("stale_reference");
        expect(fixture.requests.filter((request) => request.operation === "click")).toHaveLength(0);
      }
    }
  }),
);

it.effect("successful tab inputs record dispatch without claiming a confirmed effect", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture(true);
    for (const [method, args] of [
      ["tab_evaluate", { expression: "1" }],
      ["tab_dialog", { action: "accept" }],
      ["tab_upload", { selector: "#file", files: ["/tmp/example.txt"] }],
      ["tab_fill_secret", { secretRef: "ref", selector: "#password" }],
    ] as const) {
      expect((yield* fixture.dispatch(method, args))?.outcome).toBe("ok");
    }
    const receipts = fixture.bridge
      .takeCellImagesNow("run", "turn", "cell")
      .journal.filter((entry) => entry.receipt.method.startsWith("tab_"))
      .map((entry) => entry.receipt.outcome);
    expect(receipts).toEqual(
      Array.from({ length: 4 }, () => ({ dispatch: "confirmed", effect: "unknown" })),
    );
  }),
);

it.live("tab logs forwards an inclusive since to the preview service", () => {
  const calls: unknown[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "logs") {
        calls.push(request.input);
        return Effect.succeed({ entries: ["line"] } as A);
      }
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "unclaimed", generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); return await tab.logs({since:'2026-01-01T00:00:00Z'});`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: { entries: ["line"] } },
      });
      expect(calls).toEqual([{ since: "2026-01-01T00:00:00Z" }]);
    }),
  );
});

it.live("tab logs refuses an invalid since before the logs request", () => {
  const operations: string[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      operations.push(request.operation);
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "unclaimed", generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); try { await tab.logs({since:'bad'}); } catch (e) { return [e.code, e.nothingSent]; }`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: ["invalid_argument", true] },
      });
      expect(operations).not.toContain("logs");
    }),
  );
});

it.live("tab evaluate reaches the preview service and returns its value", () => {
  const requests: unknown[] = [];
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "evaluate") {
        requests.push(request.input);
        return Effect.succeed(2 as A);
      }
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); return await tab.evaluate('1 + 1');`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({ _tag: "Success", success: { status: "completed", value: 2 } });
      expect(requests).toEqual([{ expression: "1 + 1" }]);
    }),
  );
});

it.live("tab evaluate reports the browser guard's unsent refusal", () => {
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      request.operation === "evaluate"
        ? Effect.fail(
            new PreviewAutomationExecutionError({
              ...actionErrorContext,
              operation: "evaluate",
              reason: "Evaluation refused by guard",
              dispatched: false,
            }),
          )
        : Effect.succeed({
            tabId: formTab.tabId,
            url: formTab.url,
            control: { owner: "agent", ownedByCaller: true, generation: 0 },
          } as A),
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); try { await tab.evaluate('1'); } catch (e) { return e.nothingSent; }`,
  ]).pipe(
    Effect.map(([result]) =>
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: true },
      }),
    ),
  );
});

it.live("tab dialog answers the pending prompt through preview", () => {
  const requests: unknown[] = [];
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "dialog") requests.push(request.input);
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); await tab.dialog('accept', 'answer'); return true;`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: true },
      });
      expect(requests).toEqual([{ accept: true, promptText: "answer" }]);
    }),
  );
});

it.live("tab dialog reports no pending dialog as unsent", () => {
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      request.operation === "dialog"
        ? Effect.fail(
            new PreviewAutomationExecutionError({
              ...actionErrorContext,
              operation: "dialog",
              reason: "No dialog is pending.",
              dispatched: false,
            }),
          )
        : Effect.succeed({
            tabId: formTab.tabId,
            url: formTab.url,
            control: { owner: "agent", ownedByCaller: true, generation: 0 },
          } as A),
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); try { await tab.dialog('dismiss'); } catch (e) { return [e.nothingSent, e.message]; }`,
  ]).pipe(
    Effect.map(([result]) =>
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          status: "completed",
          value: [true, expect.stringContaining("No dialog is pending.")],
        },
      }),
    ),
  );
});

it.live("tab upload sends files and target to preview", () => {
  const requests: unknown[] = [];
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "upload") requests.push(request.input);
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); await tab.upload('#file', ['/tmp/example.txt']); return true;`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: { status: "completed", value: true },
      });
      expect(requests).toEqual([{ locator: "#file", paths: ["/tmp/example.txt"] }]);
    }),
  );
});
