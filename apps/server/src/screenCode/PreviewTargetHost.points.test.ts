import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SCREEN_RUN_LIMITS,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type ScreenHostCall,
  type ScreenObservation,
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

it.effect("an action retires the screenshot points it may have moved, and keeps element refs", () =>
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
                    height: 100,
                    region: { kind: "viewport", x: 0, y: 0, width: 100, height: 100 },
                    scale: 1,
                  },
                }
              : {}) as A,
        ),
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
    const observed = yield* host.dispatch(call("observe", 3, { screenshot: true }, ref), context);
    const image = observed.imageMetadata!;
    const element = (observed.value as ScreenObservation).elements[0]!.ref;
    const point = { observationId: image.observationId, regionId: image.regionId, x: 5, y: 5 };
    yield* host.dispatch(call("scroll", 4, { deltaY: 300 }, ref), context);
    const moved = yield* host
      .dispatch(call("click", 5, { point }, ref), context)
      .pipe(Effect.result);
    expect(moved._tag === "Failure" && moved.failure.code).toBe("stale_reference");
    const kept = yield* host.dispatch(call("click", 6, { ref: element }, ref), context);
    expect(kept.category).toBeDefined();
  }),
);
