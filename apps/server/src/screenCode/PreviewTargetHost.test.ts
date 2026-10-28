import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationExecutionError,
  PreviewAutomationConnectionId,
  PreviewAutomationControlInterruptedError,
  DEFAULT_SCREEN_RUN_LIMITS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PreviewTabId,
  PreviewAutomationInvalidSelectorError,
  type PreviewAutomationError,
  type ScreenObservation,
  type ScreenHostCall,
  type ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";

const scope = {
  environmentId: EnvironmentId.make("env"),
  requestNamespace: "session",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  reauthorize: () => Effect.void,
};
const context = {
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  environmentId: "env",
  threadId: "thread",
  invocation: scope,
  limits: DEFAULT_SCREEN_RUN_LIMITS,
};
const call = (
  method: ScreenHostCall["method"],
  callId: number,
  args: ScreenHostCall["args"],
  targetRef?: ScreenTargetRef,
): ScreenHostCall => ({
  t: "call" as const,
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  callId,
  method,
  args: [args],
  deadlineMillis: 1000,
  ...(targetRef ? { targetRef } : {}),
});

const browserFixture = Effect.fn("PreviewTargetHostTest.browserFixture")(function* () {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("tab"),
    title: "Workspace",
    url: "https://example.test/",
    owner: "unclaimed" as const,
    ownedByCaller: false,
    controlGeneration: 0,
  };
  const state = {
    url: tab.url,
    generation: 0,
    statusTabId: tab.tabId,
    clicked: false,
    failure: undefined as PreviewAutomationError | undefined,
    snapshotFailure: undefined as PreviewAutomationError | undefined,
    navigateOnClick: false,
  };
  const requests: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0][] = [];
  const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
    listBoundTabs: () => Effect.succeed([tab]),
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
      requests.push(request);
      if (request.operation === "status")
        return Effect.succeed({
          tabId: state.statusTabId,
          url: state.url,
          title: tab.title,
          loading: false,
          control: { owner: tab.owner, ownedByCaller: false, generation: state.generation },
        } as A);
      if (request.operation === "snapshot") {
        if (state.snapshotFailure) return Effect.fail(state.snapshotFailure);
        return Effect.succeed({
          url: state.url,
          title: tab.title,
          loading: false,
          accessibilityTree:
            "- heading Workspace\n- button Save [ref=e1]\n- text: Ready" +
            (state.clicked ? "\n- button Cancel [ref=e2]" : ""),
          treeComplete: true,
          refGeneration: state.clicked ? "ns-4" : "ns-3",
        } as A);
      }
      if (state.failure) return Effect.fail(state.failure);
      if (request.operation === "read")
        return Effect.succeed({ url: state.url, title: tab.title, text: "# Workspace" } as A);
      state.clicked = true;
      if (state.navigateOnClick) state.url = "https://next.test/";
      return Effect.succeed({ ok: true } as A);
    },
  };
  const host = yield* makePreviewTargetHost(broker);
  const bridge = new ScreenHostBridge();
  bridge.setDispatcher(host);
  const binding = yield* bridge.handle(call("select_tab", 1, { tabId: tab.tabId }), context);
  if (!binding || binding.outcome !== "ok") throw new Error("Expected exact tab binding");
  const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
  let callId = 1;
  // A failed call halts its cell, so the next call starts a new cell as an agent would.
  let cellId = "cell";
  let cells = 0;
  const dispatch = (method: ScreenHostCall["method"], args: ScreenHostCall["args"] = {}) =>
    bridge.handle({ ...call(method, ++callId, args, ref), cellId }, { ...context, cellId }).pipe(
      Effect.tap((reply) =>
        Effect.sync(() => {
          if (reply?.outcome === "error") cellId = `cell-${++cells}`;
        }),
      ),
    );
  const observe = Effect.fn("PreviewTargetHostTest.observe")(function* (
    args: ScreenHostCall["args"] = {},
  ) {
    const reply = yield* dispatch("observe", args);
    expect(reply?.outcome).toBe("ok");
    return reply?.value as ScreenObservation;
  });
  return { state, requests, dispatch, observe, bridge, ref };
});

it.effect("a cell reads page text from an unclaimed tab within the reply budget", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    const first = yield* fixture.observe();
    const page = yield* fixture.dispatch("read_page", {
      scope: { ref: first.elements[0]!.ref },
      format: "text",
      maxBytes: 48_000,
    });
    expect(page?.value).toMatchObject({ text: "# Workspace" });
    const request = fixture.requests.find((entry) => entry.operation === "read");
    expect(request?.input).toMatchObject({ scope: { ref: "e1" }, format: "text" });
    expect((request?.input as { maxBytes: number } | undefined)?.maxBytes).toBeLessThan(
      DEFAULT_SCREEN_RUN_LIMITS.returnBytes,
    );
    expect(request?.exact).not.toHaveProperty("controlGeneration");
    for (const invalid of [{ expand: true }, { offset: -2 }, { format: "oops" }, { tabId: "x" }])
      expect((yield* fixture.dispatch("read_page", invalid))?.error?.code).toBe("invalid_argument");
    expect((yield* fixture.dispatch("read_page", { maxChars: 500 }))?.outcome).toBe("ok");
    const tiny = yield* fixture.bridge.handle(
      { ...call("read_page", 90, {}, fixture.ref), cellId: "cell-tiny" },
      {
        ...context,
        cellId: "cell-tiny",
        limits: { ...DEFAULT_SCREEN_RUN_LIMITS, returnBytes: 900 },
      },
    );
    expect(tiny?.error?.code).toBe("output_limit");
    expect(fixture.requests.filter((entry) => entry.operation === "read")).toHaveLength(2);
  }),
);

it.effect("observe passes interactive-only and scope narrowing to the snapshot", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.observe({ interactiveOnly: true, scope: { selector: "main" } });
    expect(fixture.requests.find((entry) => entry.operation === "snapshot")?.input).toMatchObject({
      interactiveOnly: true,
      scope: { selector: "main" },
    });
  }),
);

it.effect("actions retire refs while preserving the last complete tree for a diff", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const first = yield* fixture.observe();
    const ref = first.elements[0]!.ref;
    const clicked = yield* fixture.dispatch("click", { ref });
    expect(clicked?.outcome).toBe("ok");
    const stale = yield* fixture.dispatch("click", { ref });
    expect(stale?.error).toMatchObject({ code: "stale_reference", effectStarted: false });
    const diff = yield* fixture.observe({ mode: "diff" });
    expect(diff.mode).toBe("diff");
    expect(diff.indexedText).toBe("+ - button Cancel [ref=e2]");
    expect(diff.elements).toHaveLength(1);
    const receipt = fixture.bridge
      .takeCellImagesNow("run", "turn", "cell")
      .journal.find((entry) => entry.receipt.method === "click")?.receipt;
    expect(receipt).toMatchObject({
      category: "unverifiable",
      dispatched: true,
      evidence: ["dispatched; observe to confirm"],
    });
  }),
);

it.effect("typing and selecting from a cell wait no longer than the cell has left", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const first = yield* fixture.observe();
    yield* fixture.dispatch("type_text", { ref: first.elements[0]!.ref, text: "x" });
    expect(fixture.requests.find((entry) => entry.operation === "type")?.input).toMatchObject({
      text: "x",
      timeoutMs: 1000,
    });
    yield* TestClock.adjust("400 millis");
    const second = yield* fixture.observe();
    yield* fixture.dispatch("select", { ref: second.elements[0]!.ref, values: ["a"] });
    expect(fixture.requests.find((entry) => entry.operation === "select")?.input).toMatchObject({
      values: ["a"],
      timeoutMs: 600,
    });
  }),
);

it.effect("same-tab origin changes require observation before further input", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const first = yield* fixture.observe();
    fixture.state.navigateOnClick = true;
    yield* fixture.dispatch("click", { ref: first.elements[0]!.ref });
    const fenced = yield* fixture.dispatch("press_key", { key: "Enter" });
    expect(fenced?.error).toMatchObject({ code: "stale_reference", effectStarted: false });
    const status = yield* fixture.dispatch("tab_status");
    expect(status?.value).toMatchObject({ url: "https://next.test/" });
    expect((yield* fixture.dispatch("press_key", { key: "Enter" }))?.outcome).toBe("error");
    const next = yield* fixture.observe({ mode: "diff", baseObservationId: first.observationId });
    expect(next).toMatchObject({ mode: "full", url: "https://next.test/" });
    expect((yield* fixture.dispatch("click", { ref: first.elements[0]!.ref }))?.error?.code).toBe(
      "stale_reference",
    );
    expect((yield* fixture.dispatch("click", { ref: next.elements[0]!.ref }))?.outcome).toBe("ok");
    expect(
      fixture.requests.filter((request) => request.operation === "click").at(-1)?.exact?.origin,
    ).toBe("https://next.test");
  }),
);

it.effect("observation cannot refresh a replaced tab or control generation", () =>
  Effect.gen(function* () {
    for (const changed of [{ generation: 1 }, { statusTabId: PreviewTabId.make("replacement") }]) {
      const fixture = yield* browserFixture();
      yield* fixture.observe();
      Object.assign(fixture.state, changed, { url: "https://next.test/" });
      expect((yield* fixture.dispatch("observe"))?.error).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(fixture.requests.filter((request) => request.operation === "snapshot")).toHaveLength(
        1,
      );
    }
  }),
);

it.effect("tab status reads an unclaimed tab and rejects unexpected arguments", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    expect((yield* fixture.dispatch("tab_status"))?.value).toMatchObject({
      control: { owner: "unclaimed" },
    });
    expect(
      (yield* fixture.dispatch("tab_status", { url: "https://other.test/" }))?.error?.code,
    ).toBe("invalid_argument");
    expect((yield* fixture.dispatch("press_key", { key: "Enter" }))?.error?.code).toBe(
      "permission_denied",
    );
  }),
);

const actionErrorContext = {
  operation: "click" as const,
  environmentId: scope.environmentId,
  threadId: scope.thread.threadId,
  providerSessionId: "session",
  providerInstanceId: scope.thread.providerInstanceId,
  clientId: "server-browser",
  connectionId: "connection",
  requestId: "request",
  timeoutMs: 1000,
  remoteTag: "PreviewAutomationExecutionError",
  remoteMessageLength: 100,
  cause: undefined,
};

it.effect(
  "action failures retain bounded safe detail and retire refs even when input is uncertain",
  () =>
    Effect.gen(function* () {
      const fixture = yield* browserFixture();
      yield* fixture.dispatch("claim_tab");
      const first = yield* fixture.observe();
      fixture.state.failure = new PreviewAutomationExecutionError({
        ...actionErrorContext,
        reason:
          "\u001b[31mOverlay intercepts pointer input\nhttps://private.test/?token=hidden password=hidden " +
          "x".repeat(250),
      });
      const failed = yield* fixture.dispatch("click", { ref: first.elements[0]!.ref });
      expect(failed?.error).toMatchObject({ code: "unknown_outcome", effectStarted: true });
      expect(failed?.error?.message).toContain("Overlay intercepts pointer input");
      expect(failed?.error?.message?.length).toBeLessThanOrEqual(200);
      expect(failed?.error?.message).not.toMatch(/hidden|private\.test|\u001b/);
      const stale = yield* fixture.dispatch("click", { ref: first.elements[0]!.ref });
      expect(stale?.error).toMatchObject({ code: "stale_reference", effectStarted: false });
    }),
);

it.effect("selector rejection reports that input did not start", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const first = yield* fixture.observe();
    fixture.state.failure = new PreviewAutomationInvalidSelectorError({
      ...actionErrorContext,
      staleRef: true,
    });
    const failed = yield* fixture.dispatch("click", { ref: first.elements[0]!.ref });
    expect(failed?.error).toMatchObject({ code: "downstream_failure", effectStarted: false });
    expect(failed?.error?.message).toContain("stale");
  }),
);

it.effect("a failed observation cannot authorize input on a changed origin", () =>
  Effect.gen(function* () {
    const fixture = yield* browserFixture();
    yield* fixture.dispatch("claim_tab");
    const first = yield* fixture.observe();
    fixture.state.url = "https://next.test/";
    fixture.state.snapshotFailure = new PreviewAutomationExecutionError({
      ...actionErrorContext,
      operation: "snapshot",
      reason: "Tree capture failed",
    });
    const failed = yield* fixture.dispatch("observe");
    expect(failed?.error).toMatchObject({ code: "downstream_failure", effectStarted: false });
    expect((yield* fixture.dispatch("press_key", { key: "Enter" }))?.error?.code).toBe(
      "stale_reference",
    );
    fixture.state.snapshotFailure = undefined;
    const next = yield* fixture.observe();
    expect((yield* fixture.dispatch("click", { ref: first.elements[0]!.ref }))?.error?.code).toBe(
      "stale_reference",
    );
    expect((yield* fixture.dispatch("click", { ref: next.elements[0]!.ref }))?.outcome).toBe("ok");
  }),
);

it.effect("refuses a full-page image point before dispatching a viewport click", () =>
  Effect.gen(function* () {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const operations: string[] = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        operations.push(request.operation);
        return Effect.succeed(
          (request.operation === "status"
            ? {
                tabId: tab.tabId,
                url: tab.url,
                control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
              }
            : {
                url: tab.url,
                title: tab.title,
                loading: false,
                accessibilityTree: "- button Save [ref=e1]",
                treeComplete: true,
                refGeneration: "1",
                screenshot: {
                  mimeType: "image/png",
                  data: "AQID",
                  width: 100,
                  height: 2000,
                  region: { kind: "document", x: 0, y: 0, width: 100, height: 2000 },
                  scale: 1,
                },
              }) as A,
        );
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
    const observed = yield* host.dispatch(
      call("observe", 3, { screenshot: true, fullPage: true }, ref),
      context,
    );
    const image = observed.imageMetadata!;
    const result = yield* host
      .dispatch(
        call(
          "click",
          4,
          {
            point: { observationId: image.observationId, regionId: image.regionId, x: 20, y: 1500 },
          },
          ref,
        ),
        context,
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({ code: "unsupported", effectStarted: false });
      expect(result.failure.nextStep).toContain("viewport screenshot");
    }
    expect(operations).not.toContain("click");
  }),
);

it.effect("preview capability revoked between cells refuses discovery before broker dispatch", () =>
  Effect.gen(function* () {
    let calls = 0;
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      invoke: <A>() => {
        calls++;
        return Effect.succeed(null as A);
      },
      listBoundTabs: () => {
        calls++;
        return Effect.succeed([]);
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const denied = { ...context, invocation: { ...scope, capabilities: new Set([] as const) } };
    const result = yield* host.dispatch(call("list_tabs", 1, {}), denied).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(0);
  }),
);

it.effect("default observation does not capture an image", () =>
  Effect.gen(function* () {
    const inputs: unknown[] = [];
    const tab = {
      environmentId: "env",
      browserInstanceId: "goat-server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        inputs.push(request);
        const value =
          request.operation === "status"
            ? {
                tabId: tab.tabId,
                url: tab.url,
                control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
              }
            : {
                url: tab.url,
                title: "Page",
                loading: false,
                visibleText: "",
                interactiveElements: [],
                accessibilityTree: "- button [ref=e1]",
                consoleEntries: [],
                networkEntries: [],
                actionTimeline: [],
                treeComplete: true,
                refGeneration: "1",
              };
        return Effect.succeed(value as A);
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const value = binding.value as { targetRef: ScreenTargetRef };
    const observation = yield* host.dispatch(
      call("observe", 2, { targetRef: value.targetRef }, value.targetRef),
      context,
    );
    expect((observation.value as { mode: string }).mode).toBe("full");
    expect(
      inputs.some(
        (input) =>
          (input as { operation: string; input: { captureImage?: boolean } }).operation ===
            "snapshot" &&
          (input as { input: { captureImage?: boolean } }).input.captureImage === false,
      ),
    ).toBe(true);
    expect(observation.image).toBeUndefined();
  }),
);

it.effect(
  "a default-limit screenshot observation of a large tree returns truncated elements and its image instead of output_limit",
  () =>
    Effect.gen(function* () {
      const tab = {
        environmentId: "env",
        browserInstanceId: "goat-server-browser",
        connectionId: "connection",
        threadId: "thread",
        tabId: PreviewTabId.make("tab"),
        title: "Page",
        url: "https://example.test/",
        owner: "unclaimed" as const,
        ownedByCaller: false,
        controlGeneration: 0,
      };
      const tree = Array.from(
        { length: 400 },
        (_, index) => `- button Item ${index} [ref=e${index}]`,
      ).join("\n");
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([tab]),
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
          Effect.succeed(
            (request.operation === "status"
              ? {
                  tabId: tab.tabId,
                  url: tab.url,
                  control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
                }
              : {
                  url: tab.url,
                  title: tab.title,
                  loading: false,
                  accessibilityTree: tree,
                  treeComplete: true,
                  refGeneration: "1",
                  screenshot: {
                    mimeType: "image/png",
                    data: "AQID",
                    width: 2,
                    height: 2,
                    region: { kind: "viewport", x: 0, y: 0, width: 1280, height: 720 },
                    scale: 2,
                  },
                }) as A,
          ),
      };
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher(yield* makePreviewTargetHost(broker));
      const binding = yield* bridge.handle(call("select_tab", 1, { tabId: "tab" }), context);
      expect(binding?.outcome).toBe("ok");
      if (!binding || binding.outcome !== "ok") throw new Error("Expected tab binding");
      const targetRef = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
      const reply = yield* bridge.handle(
        call("observe", 2, { screenshot: true }, targetRef),
        context,
      );
      expect(reply?.outcome).toBe("ok");
      if (!reply || reply.outcome !== "ok") throw new Error("Expected observation");
      expect(reply.value).toMatchObject({ truncated: true, image: { mimeType: "image/png" } });
      expect((reply.value as { elements: unknown[] }).elements.length).toBeLessThan(400);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(
        context.limits.returnBytes,
      );
    }),
);

it.effect("requested image metadata matches its observation while bytes remain host-owned", () =>
  Effect.gen(function* () {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.succeed(
          (request.operation === "status"
            ? {
                tabId: tab.tabId,
                url: tab.url,
                control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
              }
            : {
                url: tab.url,
                title: "Page",
                loading: false,
                visibleText: "",
                interactiveElements: [],
                accessibilityTree: "- button [ref=e1]",
                consoleEntries: [],
                networkEntries: [],
                actionTimeline: [],
                treeComplete: true,
                refGeneration: "1",
                screenshot: {
                  mimeType: "image/png",
                  data: "AQID",
                  width: 2,
                  height: 2,
                  region: { kind: "viewport", x: 5, y: 10, width: 1, height: 1 },
                  scale: 2,
                },
              }) as A,
        ),
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    const result = yield* host.dispatch(
      call("observe", 2, { screenshot: true, targetRef: ref }, ref),
      context,
    );
    expect(result.image?.bytes).toBe("AQID");
    expect(result.imageMetadata?.observationId).toBe(
      (result.value as { observationId: string }).observationId,
    );
    expect(JSON.stringify(result.value)).not.toContain("AQID");
  }),
);

it.effect("binds the exact mentioned browser instance and tab, not its title", () =>
  Effect.gen(function* () {
    const first = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "first",
      threadId: "thread",
      tabId: PreviewTabId.make("tab-a"),
      title: "Workspace",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 1,
    };
    const second = {
      ...first,
      browserInstanceId: "other-browser",
      connectionId: "second",
      tabId: PreviewTabId.make("tab-b"),
    };
    let tabs = [first, second];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed(tabs),
      invoke: <A>() => Effect.succeed(null as A),
    };
    const host = yield* makePreviewTargetHost(broker);
    host.setBindingHints(context, {
      browserRequested: true,
      computerRequested: false,
      appIds: [],
      tabs: [
        {
          mentionId: "mention",
          environmentId: "env",
          browserInstanceId: "server-browser",
          tabId: "tab-a",
          titleAtMention: "Workspace",
          urlAtMention: "https://example.test/",
        },
      ],
    });
    const binding = yield* host.dispatch(call("select_tab", 1, { mentionId: "mention" }), context);
    expect(
      (binding.value as { tab: { browserInstanceId: string; tabId: string } }).tab,
    ).toMatchObject({
      browserInstanceId: "server-browser",
      tabId: "tab-a",
    });
    tabs = [{ ...first, title: "Changed" }, second];
    const retitled = yield* host
      .dispatch(call("select_tab", 2, { mentionId: "mention" }), context)
      .pipe(Effect.result);
    expect(retitled._tag).toBe("Success");
    tabs = [{ ...first, browserInstanceId: "replaced-browser" }, second];
    const replaced = yield* host
      .dispatch(call("select_tab", 3, { mentionId: "mention" }), context)
      .pipe(Effect.result);
    expect(replaced._tag).toBe("Failure");
  }),
);

it.effect("Stop still closes the agent's own temporary tab after its generation moved", () =>
  Effect.gen(function* () {
    let generation = 1;
    const closes: Array<{ controlGeneration?: number }> = [];
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("temporary"),
      title: "New tab",
      url: "https://example.test/",
      owner: "agent" as const,
      ownedByCaller: true,
      controlGeneration: 1,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([{ ...tab, controlGeneration: generation }]),
      invoke: <A>(request: { operation: string; exact?: { controlGeneration?: number } }) =>
        Effect.sync(() => {
          if (request.operation === "close") closes.push({ ...request.exact });
          return {
            available: true,
            visible: true,
            tabId: tab.tabId,
            url: tab.url,
            title: tab.title,
            loading: false,
            control: { owner: "agent", ownedByCaller: true, generation },
          } as A;
        }),
    };
    const host = yield* makePreviewTargetHost(broker);
    yield* host.dispatch(call("open_tab", 1, { url: tab.url }), context);
    // The person's Stop bumps the tab's control generation before cleanup reads it.
    generation = 2;
    const outcomes = yield* host.releaseControl({ runId: "run", turnId: "turn" });
    expect(outcomes).toEqual([{ tabId: "temporary", status: "closed" }]);
    expect(closes).toEqual([expect.objectContaining({ controlGeneration: 2 })]);
  }),
);

it.effect(
  "keeps a tab its agent handed to a person open at turn end, without a cleanup failure (#1218)",
  () =>
    Effect.gen(function* () {
      let generation = 1;
      let waitingForPerson = false;
      const closes: Array<string> = [];
      const tab = {
        environmentId: "env",
        browserInstanceId: "server-browser",
        connectionId: "connection",
        threadId: "thread",
        tabId: PreviewTabId.make("sign-in"),
        title: "Sign in",
        url: "https://login.example.test/",
        owner: "agent" as const,
        ownedByCaller: true,
        controlGeneration: 1,
      };
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([{ ...tab, controlGeneration: generation }]),
        invoke: <A>(request: { operation: string }) =>
          Effect.sync(() => {
            if (request.operation === "close") closes.push(tab.tabId);
            return {
              available: true,
              visible: true,
              tabId: tab.tabId,
              url: tab.url,
              title: tab.title,
              loading: false,
              control: {
                owner: "agent",
                ownedByCaller: true,
                generation,
                ...(waitingForPerson ? { waitingForPerson: true } : {}),
              },
            } as A;
          }),
      };
      const host = yield* makePreviewTargetHost(broker);
      yield* host.dispatch(call("open_tab", 1, { url: tab.url }), context);
      // The request moves the tab's generation, as a takeover does.
      generation = 2;
      waitingForPerson = true;
      const outcomes = yield* host.finishTurn({ runId: "run", turnId: "turn" });
      expect(outcomes).toEqual([{ tabId: "sign-in", status: "kept" }]);
      expect(closes).toEqual([]);
    }),
);

it.effect("a tab that opens after its turn was fenced is closed instead of escaping cleanup", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const operations: string[] = [];
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("late"),
      title: "New tab",
      url: "https://example.test/",
      owner: "agent" as const,
      ownedByCaller: true,
      controlGeneration: 1,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: { operation: string }) =>
        Effect.gen(function* () {
          operations.push(request.operation);
          if (request.operation === "open") {
            yield* Deferred.succeed(opening, undefined);
            yield* Deferred.await(release);
          }
          return { tabId: tab.tabId } as A;
        }),
    };
    const host = yield* makePreviewTargetHost(broker);
    const running = yield* host
      .dispatch(call("open_tab", 1, { url: tab.url }), context)
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(opening);
    yield* host.finishTurn({ runId: "run", turnId: "turn" });
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(running);
    expect(result._tag).toBe("Failure");
    expect(operations).toEqual(["open", "close"]);
  }),
);

it.effect("preview host preserves possible commit before converting a typed execution error", () =>
  Effect.gen(function* () {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "type")
          return Effect.fail(
            new PreviewAutomationExecutionError({
              ...scope.thread,
              environmentId: scope.environmentId,
              operation: "type",
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              requestId: "request",
              timeoutMs: 1000,
              remoteTag: "Error",
              remoteMessageLength: 0,
              cause: undefined,
            }),
          );
        return Effect.succeed({
          tabId: tab.tabId,
          url: tab.url,
          control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
        } as A);
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
    const result = yield* host
      .dispatch(
        { ...call("click", 3, {}, ref), method: "type_text", args: [{ text: "hello" }] },
        context,
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        effectStarted: true,
        safety: { possibleCommit: true, retryClass: "never" },
      });
  }),
);

it.effect("preview host keeps a refusal before input as nothing started", () =>
  Effect.gen(function* () {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Page",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "type")
          return Effect.fail(
            new PreviewAutomationControlInterruptedError({
              ...scope.thread,
              environmentId: scope.environmentId,
              operation: "type",
              clientId: "browser",
              connectionId: PreviewAutomationConnectionId.make("connection"),
              requestId: "request",
              timeoutMs: 1000,
              remoteTag: "PreviewAutomationControlInterruptedError",
              remoteMessageLength: 0,
              cause: undefined,
              reason: "stopped",
              dispatched: false,
            }),
          );
        return Effect.succeed({
          tabId: tab.tabId,
          url: tab.url,
          control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
        } as A);
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
    const result = yield* host
      .dispatch(
        { ...call("click", 3, {}, ref), method: "type_text", args: [{ text: "hello" }] },
        context,
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        effectStarted: false,
        safety: { possibleCommit: false },
      });
  }),
);
