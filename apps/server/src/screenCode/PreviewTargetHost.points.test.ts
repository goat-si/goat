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

it.effect(
  "viewport points drive a coordinate drag and a wheel at that point, within the cell",
  () =>
    Effect.gen(function* () {
      const tab = {
        environmentId: "env",
        browserInstanceId: "server-browser",
        connectionId: "connection",
        threadId: "thread",
        tabId: PreviewTabId.make("tab"),
        title: "Map",
        url: "https://example.test/",
        owner: "unclaimed" as const,
        ownedByCaller: false,
        controlGeneration: 0,
      };
      const inputs: Array<[string, unknown]> = [];
      const budgets: Array<number | undefined> = [];
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([tab]),
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
          if (request.operation !== "status" && request.operation !== "snapshot")
            inputs.push([request.operation, request.input]);
          if (request.operation === "drag" || request.operation === "scroll")
            budgets.push(request.timeoutMs);
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
                    accessibilityTree: "- region Map",
                    treeComplete: true,
                    refGeneration: "1",
                    screenshot: {
                      mimeType: "image/png",
                      data: "AQID",
                      width: 200,
                      height: 100,
                      region: { kind: "viewport", x: 0, y: 0, width: 400, height: 200 },
                      scale: 0.5,
                    },
                  }
                : {}) as A,
          );
        },
      };
      const host = yield* makePreviewTargetHost(broker);
      const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
      const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
      yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
      const image = (yield* host.dispatch(call("observe", 3, { screenshot: true }, ref), context))
        .imageMetadata!;
      const at = (x: number, y: number) => ({
        observationId: image.observationId,
        regionId: image.regionId,
        x,
        y,
      });
      yield* host.dispatch(
        call("drag", 4, { point: at(10, 10), toPoint: at(60, 30) }, ref),
        context,
      );
      // The drag may have moved what the screenshot showed, so the wheel uses a fresh one.
      const again = (yield* host.dispatch(call("observe", 5, { screenshot: true }, ref), context))
        .imageMetadata!;
      const point = { observationId: again.observationId, regionId: again.regionId, x: 50, y: 50 };
      yield* host.dispatch(call("scroll", 6, { point, deltaY: -120 }, ref), context);
      expect(inputs).toEqual([
        ["drag", { from: { x: 20, y: 20 }, to: { x: 120, y: 60 } }],
        ["scroll", { x: 100, y: 100, deltaX: 0, deltaY: -120 }],
      ]);
      // Pointer input ends with the cell, so nothing lands after the cell stopped waiting.
      expect(budgets).toEqual([1000, 1000]);
    }),
);

type ReuseScenario =
  | "reuse"
  | "omitted"
  | "omittedViewport"
  | "older"
  | "document"
  | "viewport"
  | "missingViewport"
  | "navigate"
  | "observe"
  | "clearBasis"
  | "clearDocument";

const runReuseScenario = (scenario: ReuseScenario) =>
  Effect.gen(function* () {
    const tab = {
      environmentId: "env",
      browserInstanceId: "server-browser",
      connectionId: "connection",
      threadId: "thread",
      tabId: PreviewTabId.make("tab"),
      title: "Calculator",
      url: "https://example.test/",
      owner: "unclaimed" as const,
      ownedByCaller: false,
      controlGeneration: 0,
    };
    let url = tab.url;
    let documentGeneration: number | undefined = 1;
    let viewport = scenario === "older" ? undefined : { width: 100, height: 80 };
    let capture = { width: 120, height: 90 };
    let snapshots = 0;
    let domValue = 0;
    const clicks: unknown[] = [];
    const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
      listBoundTabs: () => Effect.succeed([tab]),
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) => {
        if (request.operation === "click") {
          clicks.push(request.input);
          domValue += 1;
        }
        if (request.operation === "snapshot") snapshots += 1;
        if (request.operation === "navigate") {
          url = "https://example.test/next";
          return Effect.succeed({ url } as A);
        }
        return Effect.succeed(
          (request.operation === "status"
            ? {
                tabId: tab.tabId,
                url,
                documentGeneration,
                ...(viewport ? { viewport } : {}),
                control: { owner: tab.owner, ownedByCaller: false, generation: 0 },
              }
            : request.operation === "snapshot"
              ? {
                  url,
                  title: tab.title,
                  loading: false,
                  accessibilityTree: `- text: ${domValue}\n- button Seven [ref=e1]`,
                  treeComplete: true,
                  refGeneration: "1",
                  screenshot: {
                    mimeType: "image/png",
                    data: "AQID",
                    width: capture.width,
                    height: capture.height,
                    region: {
                      kind:
                        (request.input as { fullPage?: boolean }).fullPage === true
                          ? "document"
                          : "viewport",
                      x: 0,
                      y: 0,
                      ...capture,
                    },
                    scale: 1,
                  },
                }
              : request.operation === "click"
                ? { effect: "confirmed", evidence: ["dom-value"] }
                : {}) as A,
        );
      },
    };
    const host = yield* makePreviewTargetHost(broker);
    const binding = yield* host.dispatch(call("select_tab", 1, { tabId: "tab" }), context);
    const ref = (binding.value as { targetRef: ScreenTargetRef }).targetRef;
    yield* host.dispatch(call("claim_tab", 2, {}, ref), context);
    const observed = yield* host.dispatch(call("observe", 3, { screenshot: true }, ref), {
      ...context,
      limits: {
        ...context.limits,
        ...(scenario === "omitted" || scenario === "omittedViewport" ? { imageBytes: 2 } : {}),
      },
    });
    if (scenario === "omitted" || scenario === "omittedViewport") {
      expect(observed.imageMetadata).toBeUndefined();
      expect((observed.value as ScreenObservation).image).toMatchObject({ omitted: true });
    }
    const image = observed.imageMetadata ?? (observed.value as ScreenObservation).image!;
    const at = (x: number, y: number, metadata = image) => ({
      observationId: metadata.observationId,
      regionId: metadata.regionId,
      x,
      y,
    });
    if (viewport) viewport = { ...capture };
    yield* host.dispatch(call("click", 4, { point: at(10, 10) }, ref), context);
    if (scenario === "document") documentGeneration = 2;
    if (scenario === "viewport") viewport = { width: 100, height: 80 };
    if (scenario === "omittedViewport") viewport = { width: 100, height: 80 };
    if (scenario === "missingViewport") viewport = undefined;
    if (scenario === "navigate")
      yield* host.dispatch(
        call("navigate_tab", 5, { url: "https://example.test/next" }, ref),
        context,
      );
    if (scenario === "observe") {
      documentGeneration = 2;
      viewport = { width: 140, height: 100 };
      capture = { width: 140, height: 100 };
      const replaced = yield* host.dispatch(call("observe", 5, { screenshot: true }, ref), context);
      const nextImage = replaced.imageMetadata ?? (replaced.value as ScreenObservation).image!;
      const oldPoint = yield* host
        .dispatch(call("click", 6, { point: at(20, 20) }, ref), context)
        .pipe(Effect.result);
      const newPoint = yield* host
        .dispatch(call("click", 7, { point: at(20, 20, nextImage) }, ref), context)
        .pipe(Effect.result);
      return { second: oldPoint, newPoint, clicks, snapshots, domValue };
    }
    if (scenario === "clearBasis" || scenario === "clearDocument") {
      documentGeneration = scenario === "clearBasis" ? 2 : undefined;
      viewport = undefined;
      const replaced = yield* host.dispatch(
        call(
          "observe",
          5,
          { screenshot: true, ...(scenario === "clearBasis" ? { fullPage: true } : {}) },
          ref,
        ),
        context,
      );
      const nextImage = replaced.imageMetadata ?? (replaced.value as ScreenObservation).image!;
      const oldPoint = yield* host
        .dispatch(call("click", 6, { point: at(20, 20) }, ref), context)
        .pipe(Effect.result);
      const newPoint = yield* host
        .dispatch(call("click", 7, { point: at(20, 20, nextImage) }, ref), context)
        .pipe(Effect.result);
      return { second: oldPoint, newPoint, clicks, snapshots, domValue };
    }
    const second = yield* host
      .dispatch(call("click", 6, { point: at(20, 20) }, ref), context)
      .pipe(Effect.result);
    return { second, newPoint: second, clicks, snapshots, domValue };
  });

it.effect(
  "viewport screenshot points survive clicks only while their captured basis stays current",
  () =>
    Effect.gen(function* () {
      for (const scenario of ["reuse", "omitted", "older"] as const) {
        const result = yield* runReuseScenario(scenario);
        expect(result.second._tag).toBe("Success");
        expect(result.clicks).toEqual([
          { x: 10, y: 10 },
          { x: 20, y: 20 },
        ]);
        expect(result.snapshots).toBe(1);
        expect(result.domValue).toBe(2);
      }
      for (const scenario of [
        "document",
        "viewport",
        "omittedViewport",
        "missingViewport",
        "navigate",
      ] as const) {
        const result = yield* runReuseScenario(scenario);
        expect(result.second._tag === "Failure" && result.second.failure).toMatchObject({
          code: "stale_reference",
          effectStarted: false,
        });
        expect(result.clicks).toHaveLength(1);
        expect(result.snapshots).toBe(1);
      }
      const replaced = yield* runReuseScenario("observe");
      expect(replaced.second._tag === "Failure" && replaced.second.failure).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(replaced.newPoint._tag).toBe("Success");
      expect(replaced.clicks).toHaveLength(2);
      expect(replaced.snapshots).toBe(2);
      const clearedBasis = yield* runReuseScenario("clearBasis");
      expect(clearedBasis.second._tag === "Failure" && clearedBasis.second.failure).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(
        clearedBasis.newPoint._tag === "Failure" && clearedBasis.newPoint.failure,
      ).toMatchObject({
        code: "unsupported",
        effectStarted: false,
      });
      expect(clearedBasis.clicks).toHaveLength(1);
      const clearedDocument = yield* runReuseScenario("clearDocument");
      expect(
        clearedDocument.second._tag === "Failure" && clearedDocument.second.failure,
      ).toMatchObject({
        code: "stale_reference",
        effectStarted: false,
      });
      expect(clearedDocument.newPoint._tag).toBe("Success");
      expect(clearedDocument.clicks).toHaveLength(2);
    }),
);
