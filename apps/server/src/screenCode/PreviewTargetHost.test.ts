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
  type ScreenHostCall,
  type ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
  method: "list_tabs" | "select_tab" | "observe" | "open_tab" | "claim_tab" | "click",
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
