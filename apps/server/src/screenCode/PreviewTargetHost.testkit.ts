import { expect } from "@effect/vitest";
import {
  DEFAULT_SCREEN_RUN_LIMITS,
  EnvironmentId,
  PreviewTabId,
  PreviewAutomationTimeoutError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationError,
  type ScreenHostCall,
  type ScreenObservation,
  type ScreenTargetRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { makePreviewTargetHost } from "./PreviewTargetHost.ts";

/** Shared fixtures for the preview target host tests. */
export const scope = {
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
export const context = {
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  environmentId: "env",
  threadId: "thread",
  invocation: scope,
  limits: DEFAULT_SCREEN_RUN_LIMITS,
};
export const call = (
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
  deadlineMillis: 10_000,
  ...(targetRef ? { targetRef } : {}),
});

export const browserFixture = Effect.fn("PreviewTargetHostTest.browserFixture")(function* (
  ownedByCaller = false,
) {
  const tab = {
    environmentId: "env",
    browserInstanceId: "server-browser",
    connectionId: "connection",
    threadId: "thread",
    tabId: PreviewTabId.make("tab"),
    title: "Workspace",
    url: "https://example.test/",
    owner: ownedByCaller ? ("agent" as const) : ("unclaimed" as const),
    ownedByCaller,
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
    clickResult: { ok: true } as object,
    /** Replaces the observed tree, for a page with other controls. */
    tree: undefined as string | undefined,
    /** Applies the input, then loses the reply, as a dropped connection does. */
    lostReply: undefined as PreviewAutomationError | undefined,
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
          control: { owner: tab.owner, ownedByCaller, generation: state.generation },
        } as A);
      if (request.operation === "snapshot") {
        if (state.snapshotFailure) return Effect.fail(state.snapshotFailure);
        return Effect.succeed({
          url: state.url,
          title: tab.title,
          loading: false,
          accessibilityTree:
            state.tree ??
            "- heading Workspace\n- button Save [ref=e1]\n- text: Ready" +
              (state.clicked ? "\n- button Cancel [ref=e2]" : ""),
          treeComplete: true,
          refGeneration: state.clicked ? "ns-4" : "ns-3",
          // The server browser captures whenever the read asked for an image.
          ...((request.input as { captureImage?: boolean }).captureImage
            ? {
                screenshot: {
                  mimeType: "image/png",
                  data: "AQID",
                  width: 100,
                  height: 80,
                  region: { kind: "viewport", x: 0, y: 0, width: 100, height: 80 },
                  scale: 1,
                },
              }
            : {}),
        } as A);
      }
      if (state.failure) return Effect.fail(state.failure);
      if (request.operation === "claim") return Effect.succeed({} as A);
      if (request.operation === "waitFor")
        return state.clicked &&
          [undefined, "Cancel"].includes((request.input as { text?: string }).text)
          ? Effect.succeed({} as A)
          : Effect.fail(
              new PreviewAutomationTimeoutError({
                ...actionErrorContext,
                operation: "waitFor",
                remoteTag: "PreviewAutomationTimeoutError",
              }),
            );
      if (request.operation === "read")
        return Effect.succeed({ url: state.url, title: tab.title, text: "# Workspace" } as A);
      state.clicked = true;
      if (state.navigateOnClick) state.url = "https://next.test/";
      if (state.lostReply) return Effect.fail(state.lostReply);
      return Effect.succeed(state.clickResult as A);
    },
  };
  const host = yield* makePreviewTargetHost(broker);
  const bridge = new ScreenHostBridge();
  bridge.setDispatcher(host);
  const binding = yield* bridge.handle(call("select_tab", 1, { tabId: tab.tabId }), context);
  if (!binding || binding.outcome !== "ok") throw new Error("Expected exact tab binding");
  const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
  let callId = 1;
  // A failed write can halt its cell, so after any failure the next call starts a new cell.
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
  const rebind = Effect.fn("PreviewTargetHostTest.rebind")(function* () {
    const reply = yield* bridge.handle(
      { ...call("select_tab", ++callId, { tabId: tab.tabId }), cellId },
      { ...context, cellId },
    );
    if (!reply || reply.outcome !== "ok") throw new Error("Expected the tab to bind again");
    return (reply.value as { targetRef: ScreenTargetRef }).targetRef;
  });
  return { state, requests, dispatch, observe, bridge, ref, rebind, tab };
});

export const actionErrorContext = {
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
