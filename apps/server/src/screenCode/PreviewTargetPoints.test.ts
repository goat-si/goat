import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SCREEN_RUN_LIMITS,
  EnvironmentId,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTimeoutError,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationError,
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
  "a screenshot point aims one click only, typing never takes a point, and only an unmet wait is an answer",
  () =>
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
      let waitFailure: PreviewAutomationError | undefined;
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([tab]),
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
          operations.push(request.operation);
          if (request.operation === "waitFor" && waitFailure) return Effect.fail(waitFailure);
          return Effect.succeed(
            (request.operation === "status"
              ? {
                  tabId: tab.tabId,
                  url: tab.url,
                  control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
                }
              : request.operation === "snapshot"
                ? {
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
                      height: 80,
                      region: { kind: "viewport", x: 0, y: 0, width: 100, height: 80 },
                      scale: 1,
                    },
                  }
                : { ok: true }) as A,
          );
        },
      };
      const host = yield* makePreviewTargetHost(broker);
      const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
      const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
      yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
      const observed = yield* host.dispatch(call("observe", 3, { screenshot: true }, ref), context);
      const image = observed.imageMetadata!;
      const point = { observationId: image.observationId, regionId: image.regionId, x: 20, y: 20 };
      const typed = yield* host
        .dispatch(call("type_text", 4, { point, text: "HELLO" }, ref), context)
        .pipe(Effect.result);
      expect(typed._tag === "Failure" && typed.failure).toMatchObject({
        code: "invalid_argument",
        effectStarted: false,
      });
      expect((yield* host.dispatch(call("click", 5, { point }, ref), context)).category).toBe(
        "unverifiable",
      );
      // The click may have changed the page under that pixel, so the same point is refused.
      const again = yield* host
        .dispatch(call("click", 6, { point }, ref), context)
        .pipe(Effect.result);
      expect(again._tag === "Failure" && again.failure).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(operations.filter((operation) => operation === "click")).toHaveLength(1);
      expect(operations).not.toContain("type");

      waitFailure = new PreviewAutomationTimeoutError({
        ...actionErrorContext,
        operation: "waitFor",
        remoteTag: "PreviewAutomationTimeoutError",
      });
      const unmet = yield* host.dispatch(call("wait_for", 7, { text: "Done" }, ref), context);
      expect(unmet).toMatchObject({ value: { status: "timeout" }, category: "unverifiable" });
      waitFailure = new PreviewAutomationInvalidSelectorError({
        ...actionErrorContext,
        operation: "waitFor",
      });
      const broken = yield* host
        .dispatch(call("wait_for", 8, { selector: "##" }, ref), context)
        .pipe(Effect.result);
      expect(broken._tag).toBe("Failure");
    }),
);

it.effect(
  "a point from before the page moved on by itself is refused, and a diff never crosses scopes",
  () =>
    Effect.gen(function* () {
      const tab = {
        environmentId: "env",
        browserInstanceId: "server-browser",
        connectionId: "connection",
        threadId: "thread",
        tabId: PreviewTabId.make("tab"),
        title: "Page",
        url: "https://example.test/before",
        owner: "unclaimed" as const,
        ownedByCaller: false,
        controlGeneration: 0,
      };
      const operations: string[] = [];
      let documentGeneration = 1;
      const exacts: unknown[] = [];
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([tab]),
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
          operations.push(request.operation);
          if (request.operation === "click") exacts.push(request.exact);
          return Effect.succeed(
            (request.operation === "status"
              ? {
                  tabId: tab.tabId,
                  url: tab.url,
                  documentGeneration,
                  control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
                }
              : request.operation === "snapshot"
                ? {
                    url: tab.url,
                    title: tab.title,
                    loading: false,
                    accessibilityTree: "- heading Page\n- button Save [ref=e1]",
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
                  }
                : { ok: true }) as A,
          );
        },
      };
      const host = yield* makePreviewTargetHost(broker);
      const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
      const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
      yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
      const aimed = yield* host.dispatch(call("observe", 3, { screenshot: true }, ref), context);
      const aimedImage = aimed.imageMetadata!;
      yield* host.dispatch(
        call(
          "click",
          30,
          {
            point: {
              observationId: aimedImage.observationId,
              regionId: aimedImage.regionId,
              x: 5,
              y: 5,
            },
          },
          ref,
        ),
        context,
      );
      // The browser's own input gate gets the document the screenshot showed.
      expect(exacts).toEqual([expect.objectContaining({ documentGeneration: 1 })]);
      const observed = yield* host.dispatch(
        call("observe", 31, { screenshot: true }, ref),
        context,
      );
      const image = observed.imageMetadata!;
      // A redirect or route change the agent did not cause: same origin, a new document.
      documentGeneration = 2;
      const stale = yield* host
        .dispatch(
          call(
            "click",
            4,
            {
              point: { observationId: image.observationId, regionId: image.regionId, x: 20, y: 20 },
            },
            ref,
          ),
          context,
        )
        .pipe(Effect.result);
      expect(stale._tag === "Failure" && stale.failure).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(operations.filter((operation) => operation === "click")).toHaveLength(1);

      const full = (yield* host.dispatch(call("observe", 5, {}, ref), context)).value as {
        observationId: string;
      };
      const narrowed = (yield* host.dispatch(
        call(
          "observe",
          6,
          { mode: "diff", baseObservationId: full.observationId, interactiveOnly: true },
          ref,
        ),
        context,
      )).value;
      expect(narrowed).toMatchObject({
        mode: "full",
        resetReason: "scope_changed",
        scope: "page interactive",
      });
      const inForm = (yield* host.dispatch(
        call("observe", 7, { scope: { selector: "#form" } }, ref),
        context,
      )).value as { observationId: string };
      const formControls = (yield* host.dispatch(
        call(
          "observe",
          8,
          {
            scope: { selector: "#form" },
            interactiveOnly: true,
            mode: "diff",
            baseObservationId: inForm.observationId,
          },
          ref,
        ),
        context,
      )).value;
      expect(formControls).toMatchObject({ mode: "full", resetReason: "scope_changed" });
      const beforeReload = (yield* host.dispatch(call("observe", 9, {}, ref), context)).value as {
        observationId: string;
      };
      // A reload of the same URL with the same text is still another document.
      documentGeneration = 3;
      const reloaded = (yield* host.dispatch(
        call("observe", 10, { mode: "diff", baseObservationId: beforeReload.observationId }, ref),
        context,
      )).value;
      expect(reloaded).toMatchObject({ mode: "full" });
      expect(reloaded).toHaveProperty("resetReason");
    }),
);
