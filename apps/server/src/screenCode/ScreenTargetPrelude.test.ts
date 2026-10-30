import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PreviewAutomationTimeoutError,
  PreviewAutomationExecutionError,
  SCREEN_TARGET_CONTRACT_VERSION,
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
import {
  context as desktopContext,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

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
          new PreviewAutomationTimeoutError({
            ...actionErrorContext,
            operation: "waitFor",
            remoteTag: "PreviewAutomationTimeoutError",
          }),
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

it.live("a tab click returns a compact Done", () => {
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>() =>
      Effect.succeed({
        tabId: formTab.tabId,
        url: formTab.url,
        control: { owner: "agent", ownedByCaller: true, generation: 0 },
        effect: "unverifiable",
        evidence: [],
      } as A),
  };
  return runCells(broker, [
    "const tab = await screen.tab('form'); await tab.claim(); const plain = await tab.click('button'); const verified = await tab.click('button', {verify: true}); return {plain, verified};",
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          status: "completed",
          value: {
            plain: { ok: true, verdict: "unverifiable" },
            verified: { result: { debug: { evidence: expect.any(Array) } } },
          },
        },
      });
      if (result?._tag === "Success") {
        const value = result.success.value as { plain: unknown };
        expect(value.plain).toEqual({ ok: true, verdict: "unverifiable" });
        expect(Buffer.byteLength(JSON.stringify(value.plain))).toBeLessThanOrEqual(200);
      }
    }),
  );
});

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

it.live(
  "press with a target sends one press_key carrying that element, and send: true reaches the host only when passed",
  () => {
    const { host, sent } = fixture();
    const hostArgs: Array<unknown> = [];
    const wrappedHost: typeof host = {
      ...host,
      dispatch: (call, context) => {
        if (call.method === "press_key") hostArgs.push(call.args);
        return host.dispatch(call, context);
      },
    };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: desktopContext.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        const observation = await app.observe();
        let stale;
        try { await app.click(99); } catch (e) { stale = { code: e.code, nothingSent: e.nothingSent, message: e.message }; }
        await app.press('Enter', 0);
        await app.press('Enter', 'Apply', { send: true });
        return { hasElements: 'elements' in observation, stale };`,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: {
          hasElements: false,
          stale: {
            code: "stale_reference",
            nothingSent: true,
            message: "No [99] in the latest observe; observe() then use the new numbers.",
          },
        },
        contractVersion: SCREEN_TARGET_CONTRACT_VERSION,
      });
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(0);
      const presses = sent.filter((entry) => entry.tool === "press_key");
      expect(presses).toHaveLength(2);
      expect(presses[0]?.args).toMatchObject({ key: "Enter", element_token: "snapshot:1" });
      expect(presses[0]?.args).not.toHaveProperty("send");
      expect(presses[1]?.args).toMatchObject({ key: "Enter", element_token: "snapshot:1" });
      expect(presses[1]?.args).not.toHaveProperty("send");
      expect(hostArgs).toHaveLength(2);
      expect((hostArgs[0] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("send");
      expect((hostArgs[1] as Array<Record<string, unknown>>)[0]).toMatchObject({ send: true });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: wrappedHost }),
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

it.live(
  "app scroll takes an element or point, points stay usable after input, a name without observe reads once, a number without observe is refused, drag mixes element and point, and type forwards replace: true",
  () => {
    let failType = false;
    const TYPE_KEYS = new Set([
      "session",
      "target",
      "element_token",
      "text",
      "delay_ms",
      "delivery_mode",
    ]);
    const PRESS_KEYS = new Set([
      "session",
      "target",
      "element_token",
      "key",
      "modifiers",
      "delivery_mode",
    ]);
    const { host, sent } = fixture({
      type_text: (args: Record<string, unknown>) => {
        const unknown = Object.keys(args).filter((k) => !TYPE_KEYS.has(k));
        if (unknown.length > 0)
          return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(",")}`);
        if (failType) return { effect: "suspected_noop", code: "no_change" };
        return { effect: "confirmed", evidence: ["driver:acted"] };
      },
      press_key: (args: Record<string, unknown>) => {
        const unknown = Object.keys(args).filter((k) => !PRESS_KEYS.has(k));
        if (unknown.length > 0)
          return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(",")}`);
        return { effect: "confirmed", evidence: ["driver:acted"] };
      },
      get_window_state: (args: Record<string, unknown>) =>
        args.include_accessibility_tree === false
          ? goat2WindowState(args)
          : {
              pid: 42,
              window_id: 7,
              snapshot_id: "s0000000a",
              elements_complete: false,
              tree_format: "both",
              tree_markdown:
                '[0] AXWindow "Editor"\n  [1] AXButton "Apply"\n  [2] AXScrollArea "List"\n  [3] AXTextField "Address"',
              elements: [
                {
                  element_index: 0,
                  element_token: "s0000000a:0",
                  role: "AXWindow",
                  label: "Editor",
                  frame: { x: 10, y: 20, w: 50, h: 40 },
                },
                {
                  element_index: 1,
                  element_token: "s0000000a:1",
                  role: "AXButton",
                  label: "Apply",
                  parent_index: 0,
                  frame: { x: 20, y: 30, w: 20, h: 10 },
                },
                {
                  element_index: 2,
                  element_token: "s0000000a:2",
                  role: "AXScrollArea",
                  label: "List",
                  parent_index: 0,
                  frame: { x: 10, y: 20, w: 50, h: 40 },
                },
                {
                  element_index: 3,
                  element_token: "s0000000a:3",
                  role: "AXTextField",
                  label: "Address",
                  parent_index: 0,
                  frame: { x: 15, y: 22, w: 40, h: 10 },
                },
              ],
            },
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: desktopContext.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
          let numberBeforeObserve;
          try { await app.click(1); } catch (e) { numberBeforeObserve = e.message; }
          let pixelBeforeScreenshot;
          try { await app.click([10, 20]); } catch (e) { pixelBeforeScreenshot = e.message; }
          // Implicit read on name when no observation exists in the cell yet.
          await app.click('Apply');
          await app.scroll(2, 'down', 4);
          await app.observe({ screenshot: true });
          // [x, y] on a 2x screenshot (100x80 px for 50x40 pt window) maps [20, 16] -> (10, 8) window points,
          // and stays usable after input in the same cell.
          await app.click([20, 16]);
          await app.scroll([20, 16], 'up', 2);
          await app.click({ window: [12, 14] });
          await app.drag(1, { window: [40, 30] });
          let replaceRefused;
          try { await app.type('https://example.com', 3, { replace: true }); }
          catch (e) { replaceRefused = e.nothingSent + ':' + e.message; }
          await app.setValue(3, 'https://example.com');
          return { numberBeforeObserve, pixelBeforeScreenshot, replaceRefused };`,
      });
      expect(result.status).toBe("completed");
      expect(result.value).toEqual({
        numberBeforeObserve: "Numbers come from observe(); call it first.",
        pixelBeforeScreenshot:
          "[x, y] are screenshot pixels and this cell has no screenshot; use { window: [x, y] } window points, or take a screenshot.",
        replaceRefused:
          "true:Use setValue(target, text) to replace a field's whole value; type() inserts at the cursor.",
      });
      const actions = sent.filter(
        (entry) => !["list_apps", "list_windows", "get_window_state"].includes(entry.tool),
      );
      expect(actions.map((entry) => entry.tool)).toEqual([
        "click",
        "scroll",
        "click",
        "scroll",
        "click",
        "drag",
        "set_value",
      ]);
      expect(actions[0]?.args).toMatchObject({ element_token: "s0000000a:1" });
      expect(actions[1]?.args).toMatchObject({
        element_token: "s0000000a:2",
        direction: "down",
        amount: 4,
      });
      expect(actions[2]?.args).toMatchObject({
        x: 10,
        y: 8,
        coordinate_space: "window_points",
        window_basis: { x: 10, y: 20, w: 50, h: 40 },
      });
      expect(actions[3]?.args).toMatchObject({
        x: 10,
        y: 8,
        direction: "up",
        amount: 2,
        coordinate_space: "window_points",
      });
      expect(actions[4]?.args).toMatchObject({
        x: 12,
        y: 14,
        coordinate_space: "window_points",
      });
      expect(actions[5]?.args).toMatchObject({
        from_x: 20,
        from_y: 15,
        to_x: 40,
        to_y: 30,
        coordinate_space: "window_points",
      });
      expect(actions[6]?.args).toMatchObject({
        element_token: "s0000000a:3",
        value: "https://example.com",
      });
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

it.live(
  "tab point clicks share one screenshot until a non-click input or navigation retires it",
  () => {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("page"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: true,
      controlGeneration: 0,
    };
    const ops: Array<string> = [];
    const clickInputs: unknown[] = [];
    let snapshots = 0;
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        ops.push(request.operation);
        if (request.operation === "click") clickInputs.push(request.input);
        if (request.operation === "snapshot") {
          snapshots += 1;
          return Effect.succeed({
            url: tab.url,
            title: tab.title,
            loading: false,
            accessibilityTree: "- button Go [ref=e1]",
            treeComplete: true,
            refGeneration: "1",
            screenshot: {
              mimeType: "image/png",
              data: "AQID",
              width: 100,
              height: 80,
              region: { kind: "viewport", x: 0, y: 0, width: 100, height: 80 },
              scale: 1,
            },
          } as A);
        }
        return Effect.succeed({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.title,
          loading: false,
          refGeneration: "1",
          control: { owner: "agent", ownedByCaller: true, generation: 0 },
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
          const page = await tab.observe({ screenshot: true });
          const point = { observationId: page.image.observationId, regionId: page.image.regionId, x: 20, y: 30 };
          await tab.click({ point });
          await tab.click([40, 50], { button: 'right' });
          await tab.press('Enter', [20, 30]);
          let afterPress;
          try { await tab.click([10, 10]); } catch (error) { afterPress = error.code; }
          await tab.observe({ screenshot: true });
          await tab.navigate('https://example.test/next');
          let afterNavigate;
          try { await tab.click([10, 10]); } catch (error) { afterNavigate = error.code; }
          return { afterPress, afterNavigate };`,
        });
        expect(result).toMatchObject({
          status: "completed",
          value: { afterPress: "stale_reference", afterNavigate: "stale_reference" },
        });
        expect(snapshots).toBe(2);
        expect(clickInputs).toEqual([
          { x: 20, y: 30, timeoutMs: 5_000 },
          { x: 40, y: 50, button: "right", timeoutMs: 5_000 },
          { x: 20, y: 30, timeoutMs: 5_000 },
        ]);
        expect(ops).toContain("press");
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

it.live(
  "a tab double click goes out once with count 2, a count outside 1 to 3 is refused unsent in every call form, and Done carries its time and keeps an empty result apart from none",
  () => {
    const clicks: Array<unknown> = [];
    const answers: Record<string, unknown> = {
      "#submit": { ok: true },
      "#empty": {},
      "#none": undefined,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([formTab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "click") {
          clicks.push(request.input);
          return Effect.succeed(
            answers[String((request.input as { locator?: unknown }).locator)] as A,
          );
        }
        return Effect.succeed({
          tabId: formTab.tabId,
          url: formTab.url,
          control: { owner: "unclaimed", generation: 0 },
        } as A);
      },
    };
    return Effect.gen(function* () {
      const [result] = yield* runCells(broker, [
        `const tab = await screen.tab({tabId: 'form'});
        await tab.claim();
        screen.debug = true;
        const done = await tab.click('#submit', { count: 2 });
        const empty = await tab.click('#empty');
        const none = await tab.click('#none');
        const legacy = await tab.click({ selector: '#submit' });
        const refused = [];
        for (const attempt of [() => tab.click('#submit', { count: 4 }), () => tab.click({ selector: '#submit', count: 9 })])
          try { await attempt(); } catch (error) { refused.push([error.code, error.nothingSent]); }
        return { ms: typeof done.result.debug.value._timing?.ms, driverMs: typeof done.result.debug.value._timing?.phases?.driverMs, raw: undefined,
          empty: empty.result.debug.value, none: none.result.debug.value?._noResult !== true, noneMs: typeof none.result.debug.value?._timing?.ms, legacy, refused };`,
      ]);
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          status: "completed",
          value: {
            ms: "number",
            driverMs: "number",
            empty: {},
            none: false,
            noneMs: "number",
            legacy: { ok: true, verdict: "unverifiable" },
            refused: [
              ["invalid_argument", true],
              ["invalid_argument", true],
            ],
          },
        },
      });
      expect(clicks).toMatchObject([{ clickCount: 2 }, {}, {}, {}]);
      expect(clicks).toHaveLength(4);
    });
  },
);

it.live("an app verify gives the window 60 ms to show the condition", () => {
  const { host, sent } = fixture({ verify_state: { status: "satisfied" } });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: desktopContext.invocation,
      source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
      let hover;
      try { await app.hover('Apply'); } catch (error) { hover = [error.code, error.nothingSent]; }
      return [(await app.verify({ role: 'AXButton', name: 'Apply' })).met, hover];`,
    });
    expect(result).toMatchObject({ status: "completed", value: [true, ["unsupported", true]] });
    expect(sent.find((entry) => entry.tool === "verify_state")?.args).toMatchObject({
      timeout_ms: 60,
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        desktopHost: host,
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live(
  "an option or condition key a method does not take is refused unsent, naming the key it takes",
  () => {
    const sent: Array<string> = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([formTab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        sent.push(request.operation);
        return Effect.succeed({
          tabId: formTab.tabId,
          url: formTab.url,
          control: { owner: "unclaimed", generation: 0 },
        } as A);
      },
    };
    return Effect.gen(function* () {
      const [result] = yield* runCells(broker, [
        `const tab = await screen.tab({tabId: 'form'});
        await tab.claim();
        const refused = [];
        for (const attempt of [
          () => tab.click('#cv', { clickCount: 2 }),
          () => tab.click('#cv', { button: 'middle' }),
          () => tab.hover('#cv', { timeout: 100 }),
          () => tab.observe({ screenShot: true }),
          () => tab.waitFor({ txt: 'Saved' }),
          () => tab.type('hi', '#name', { submit: true }),
          () => screen.openTab({ url: 'http://127.0.0.1:1/', reuse: true }),
          () => tab.press('Enter', { sned: true }),
          () => tab.click({ selector: '#cv' }, { count: 2 }),
          () => tab.click({ selector: '#cv', clickCount: 2 }),
          () => tab.click({ selector: '#cv', clicks: 2, button: 'right' }),
          () => tab.click('#cv', { action: 'show_menu' }),
          () => tab.click({ role: 'button', name: 'Go', clickCount: 2 }),
          () => tab.click({ selector: '#cv' }, 2),
        ])
          try { await attempt(); refused.push('sent'); } catch (error) { refused.push([error.code, error.nothingSent, error.message]); }
        screen.state.refused = refused;
        // The forms these methods do take still go out.
        await tab.press('Enter', { send: true });
        await tab.press('Enter', '#name', { send: true });
        await tab.click({ selector: '#cv' });
        await tab.waitFor({ text: 'Saved' }, 50);
        return refused;`,
      ]);
      expect(result).toMatchObject({ _tag: "Success", success: { status: "completed" } });
      const refused =
        result?._tag === "Success"
          ? (result.success.value as Array<[string, boolean, string]>)
          : [];
      expect(refused.map(([code, nothingSent]) => [code, nothingSent])).toEqual(
        Array.from({ length: 14 }, () => ["invalid_argument", true]),
      );
      expect(refused[0]?.[2]).toContain("did you mean count?");
      expect(refused[2]?.[2]).toContain("did you mean timeoutMs?");
      expect(refused[3]?.[2]).toContain("did you mean screenshot?");
      // Only the accepted forms reached the browser: two presses, the click before the second, a click, a wait.
      expect(sent.filter((operation) => operation !== "status")).toEqual([
        "press",
        "click",
        "press",
        "click",
        "waitFor",
      ]);
    });
  },
);

it.live("an app target with a stray key is refused before any read or click", () => {
  const { host, sent } = fixture({});
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: desktopContext.invocation,
      source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
      const refused = [];
      for (const attempt of [
        () => app.click({ role: 'AXButton', name: 'Apply', clickCount: 2 }),
        () => app.click({ window: [12, 14], clickCount: 2 }),
        () => app.click('Apply', { timeoutMs: 100 }),
        () => app.observe({ query: { role: 'AXButton', nam: 'Save' } }),
      ])
        try { await attempt(); refused.push('sent'); } catch (error) { refused.push([error.code, error.nothingSent]); }
      return refused;`,
    });
    expect(result).toMatchObject({
      status: "completed",
      value: [
        ["invalid_argument", true],
        ["invalid_argument", true],
        ["invalid_argument", true],
        ["invalid_argument", true],
      ],
    });
    expect(
      sent.filter(
        (entry) =>
          entry.tool !== "list_windows" && entry.tool !== "bind_app" && entry.tool !== "list_apps",
      ),
    ).toEqual([]);
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        desktopHost: host,
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

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

it.live(
  "app rejects empty targets before observation or input and accepts an observed number",
  () => {
    const { host, sent } = fixture();
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: desktopContext.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
        const errors = [];
        for (const attempt of [
          () => app.click(undefined), () => app.click(null), () => app.click(NaN), () => app.click({}),
          () => app.click(Infinity), () => app.drag('Apply', {}), () => app.setValue({}, 'x'),
          () => app.type('x', null), () => app.press('Enter', null), () => app.scroll({}, 'down'),
          () => app.drag('Apply', undefined),
        ]) {
          try { await attempt(); errors.push('sent'); } catch (e) { errors.push([e.code, e.nothingSent]); }
        }
        await app.observe();
        for (const target of [undefined, null, NaN, {}]) {
          try { await app.click(target); errors.push('sent'); } catch (e) { errors.push([e.code, e.nothingSent]); }
        }
        await app.click(0);
        return errors;`,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: Array.from({ length: 15 }, () => ["invalid_argument", true]),
      });
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
      expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(1);
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          desktopHost: host,
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

it.live("tab rejects empty targets without input and accepts an observed number", () => {
  const operations: string[] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([formTab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      operations.push(request.operation);
      if (request.operation === "snapshot")
        return Effect.succeed({
          url: formTab.url,
          title: formTab.title,
          loading: false,
          accessibilityTree: "- button Go [ref=e1]",
          treeComplete: true,
          refGeneration: "1",
        } as A);
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
  return runCells(broker, [
    `const tab = await screen.tab({tabId: 'form'});
    await tab.claim();
    const errors = [];
    for (const attempt of [
      () => tab.click(undefined), () => tab.click(null), () => tab.click(NaN), () => tab.click({}),
      () => tab.click(-Infinity), () => tab.hover({}), () => tab.drag('#go', {}),
      () => tab.setValue({}, 'x'), () => tab.type('x', null), () => tab.press('Enter', null),
      () => tab.drag('#go', undefined),
    ]) {
      try { await attempt(); errors.push('sent'); } catch (e) { errors.push([e.code, e.nothingSent]); }
    }
    await tab.observe();
    for (const target of [undefined, null, NaN, {}]) {
      try { await tab.click(target); errors.push('sent'); } catch (e) { errors.push([e.code, e.nothingSent]); }
    }
    await tab.click(0);
    return errors;`,
  ]).pipe(
    Effect.map(([result]) => {
      expect(result).toMatchObject({
        success: {
          status: "completed",
          value: Array.from({ length: 15 }, () => ["invalid_argument", true]),
        },
      });
      expect(operations.filter((operation) => operation === "snapshot")).toHaveLength(1);
      expect(operations.filter((operation) => operation === "click")).toHaveLength(1);
    }),
  );
});
