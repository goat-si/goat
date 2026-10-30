import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewAutomationExecutionError,
  PreviewTabId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";
import * as Tracer from "effect/Tracer";
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

it.live("fillSecret sends only a reference and selector and returns no secret", () => {
  const canary = "canary-secret-not-for-output";
  const requests: unknown[] = [];
  const page = { value: "" };
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      if (request.operation === "fillSecret") {
        requests.push(request.input);
        page.value = canary;
        return Effect.succeed({
          filled: true,
          origin: "https://httpbin.test",
          privateMode: true,
        } as A);
      }
      if (request.operation === "logs")
        return Effect.succeed({ console: { entries: [{ text: "[secret]" }] } } as A);
      if (request.operation === "evaluate")
        return Effect.fail(
          new PreviewAutomationExecutionError({
            ...actionErrorContext,
            operation: "evaluate",
            reason: "guard refused [secret]",
            dispatched: false,
          }),
        );
      return Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
      } as A);
    },
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); const filled = await tab.fillSecret('#pw', 'ref'); let error; try { await tab.evaluate('1'); } catch (e) { error = { message: e.message, detail: e.detail ?? null }; } return { filled, error, logs: await tab.logs() };`,
  ]).pipe(
    Effect.withTracer(tracer),
    Effect.map(([result]) => {
      expect(result).toMatchObject({ _tag: "Success", success: { status: "completed" } });
      expect(requests).toEqual([{ selector: "#pw", secretRef: "ref" }]);
      expect(page.value).toBe(canary);
      if (result?._tag === "Success") {
        expect(result.success.journal.length).toBeGreaterThan(0);
        expect(result.success.value).toMatchObject({
          error: { message: expect.any(String) },
          logs: { console: { entries: [{ text: "[secret]" }] } },
        });
      }
      expect(JSON.stringify(result)).not.toContain(canary);
      const recorded = spans.flatMap((span) => [
        span.name,
        ...Array.from(span.attributes.values(), String),
        ...span.events.map(([name, , attrs]) => name + JSON.stringify(attrs)),
      ]);
      expect(spans.length).toBeGreaterThan(0);
      expect(recorded.some((item) => item.includes(canary))).toBe(false);
    }),
  );
});

it.live.each(["index", "ref"] as const)(
  "an observed password %s is focused before the existing secret fill",
  (key) => {
    const operations: string[] = [];
    const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([owned]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        operations.push(request.operation);
        if (request.operation === "snapshot")
          return Effect.succeed({
            url: formTab.url,
            title: "Form",
            loading: false,
            accessibilityTree: "- textbox Password [ref=e1]",
            treeComplete: true,
            refGeneration: "test",
          } as A);
        if (request.operation === "fillSecret") {
          expect(request.input).toEqual({ secretRef: "ref" });
          return Effect.succeed({ filled: true } as A);
        }
        return Effect.succeed({
          tabId: formTab.tabId,
          url: formTab.url,
          control: { owner: "agent", ownedByCaller: true, generation: 0 },
        } as A);
      },
    };
    return runCells(broker, [
      `const tab = await screen.tab('form'); const seen = await tab.observe(); await tab.fillSecret(seen.elements[0][${JSON.stringify(key)}], 'ref'); return true;`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: { status: "completed", value: true },
        });
        expect(operations.filter((op) => op === "click" || op === "fillSecret")).toEqual([
          "click",
          "fillSecret",
        ]);
      }),
    );
  },
);

it.live.each(["non-password field", "different origin"] as const)(
  "an observed %s is focused but the secret is not typed",
  (reason) => {
    const page = { value: "", clicks: 0 };
    const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([owned]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "snapshot")
          return Effect.succeed({
            url: formTab.url,
            title: "Form",
            loading: false,
            accessibilityTree: "- textbox Field [ref=e1]",
            treeComplete: true,
            refGeneration: "test",
          } as A);
        if (request.operation === "click") page.clicks++;
        if (request.operation === "fillSecret")
          return Effect.fail(
            new PreviewAutomationExecutionError({
              ...actionErrorContext,
              operation: "fillSecret",
              reason,
              dispatched: false,
            }),
          );
        return Effect.succeed({
          tabId: formTab.tabId,
          url: formTab.url,
          control: { owner: "agent", ownedByCaller: true, generation: 0 },
        } as A);
      },
    };
    return runCells(broker, [
      `const tab = await screen.tab('form'); const obs = await tab.observe();
      try { await tab.fillSecret(obs.elements[0].index, 'ref'); } catch (e) { return [e.nothingSent, e.message, e.detail ?? null]; }`,
    ]).pipe(
      Effect.map(([result]) => {
        expect(result).toMatchObject({
          _tag: "Success",
          success: { status: "completed", value: [true, expect.any(String), null] },
        });
        expect(page).toEqual({ value: "", clicks: 1 });
      }),
    );
  },
);

it.live("evaluation returns page objects without stripping their keys", () => {
  const owned = { ...formTab, owner: "agent" as const, ownedByCaller: true };
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([owned]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.succeed(
        (request.operation === "evaluate"
          ? { _timing: "page-value", _noResult: true }
          : {
              tabId: formTab.tabId,
              url: formTab.url,
              control: { owner: "agent", ownedByCaller: true, generation: 0 },
            }) as A,
      ),
  };
  return runCells(broker, [
    `const tab = await screen.tab('form'); return await tab.evaluate('pageValue');`,
  ]).pipe(
    Effect.map(([result]) =>
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          status: "completed",
          value: { _timing: "page-value", _noResult: true },
        },
      }),
    ),
  );
});
