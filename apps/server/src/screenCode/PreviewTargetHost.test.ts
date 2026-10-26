import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SCREEN_RUN_LIMITS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PreviewTabId,
  type ScreenHostCall,
  type ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
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
  method: "list_tabs" | "select_tab" | "observe",
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

it.effect("binds only the exact mentioned browser instance and tab", () =>
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
    const changed = yield* host
      .dispatch(call("select_tab", 2, { mentionId: "mention" }), context)
      .pipe(Effect.result);
    expect(changed._tag).toBe("Failure");
  }),
);
