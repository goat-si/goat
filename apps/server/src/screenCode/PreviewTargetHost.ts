// @effect-diagnostics nodeBuiltinImport:off - Target and image IDs are host-owned opaque values.
import * as NodeCrypto from "node:crypto";
import type {
  ScreenBindingHints,
  ScreenHostCall,
  ScreenImage,
  ScreenImageMetadata,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import type {
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import type { BoundPreviewTab } from "./BoundPreviewTabs.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  observationReplyBudget,
  type ScreenHostContext,
  type ScreenHostDispatcher,
} from "./ScreenHostBridge.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { makeTabClaims, type TabClaim, type TabIdentity } from "./TabClaims.ts";

const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});
const originOf = (url: string | null) => {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
};
const firstArg = (call: ScreenHostCall): Record<string, unknown> => {
  const value = Array.isArray(call.args) ? call.args[0] : undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};
const stringField = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

interface BoundTarget {
  readonly ref: ScreenTargetRef;
  readonly tab: BoundPreviewTab;
  readonly origin: string | null;
}

/** Constructs a tab dispatcher with its own turn-scoped opaque binding and claim tables. */
export const makePreviewTargetHost = Effect.fn("PreviewTargetHost.make")(function* (
  broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs">,
) {
  const observations = new ScreenObservations();
  const targets = new Map<string, BoundTarget>();
  const bindingHints = new Map<string, ScreenBindingHints>();
  const turnKey = (identity: Pick<ScreenHostContext, "runId" | "turnId">) =>
    `${identity.runId}\u0000${identity.turnId}`;
  // ServerBrowser reports a close as a Stop on that tab before the close replies. Marking our own
  // close lets ScreenRunService ignore that report instead of cutting the cell that asked for it.
  const closingTabs = new Map<string, number>();
  const closingKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;
  const isClosingOwnTab = (threadId: string, tabId: string) =>
    closingTabs.has(closingKey(threadId, tabId));
  const goneErrors = new Set([
    "PreviewAutomationTabNotFoundError",
    "PreviewAutomationNoAvailableHostError",
  ]);
  const close = (tab: TabClaim, afterStop: boolean) => {
    const scope = tabScopes.get(`${tab.runId}\u0000${tab.turnId}`);
    if (!scope) return Effect.die(new Error("Turn scope expired before tab cleanup"));
    // A person's Stop moves the tab's generation before this cleanup runs. The tab is still the
    // agent's own and no person holds it, so closing it is what that Stop asked for.
    const route = {
      browserInstanceId: tab.browserInstanceId,
      connectionId: tab.connectionId,
      tabId: tab.tabId as PreviewTabId,
    };
    return Effect.gen(function* () {
      // A tab a person or a crash already closed is what cleanup wanted, so it counts as closed.
      const gone = broker
        .listBoundTabs(scope)
        .pipe(
          Effect.map(
            (live) =>
              !live.some(
                (entry) =>
                  entry.browserInstanceId === tab.browserInstanceId && entry.tabId === tab.tabId,
              ),
          ),
        );
      const status = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
          exact: route,
          updateCurrentTab: false,
        })
        .pipe(Effect.result);
      if (status._tag === "Failure") {
        if (goneErrors.has(status.failure._tag) && (yield* gone)) return;
        return yield* status.failure;
      }
      const current = status.success;
      if (current.tabId !== tab.tabId && (yield* gone)) return;
      if (
        current.tabId !== tab.tabId ||
        current.control === undefined ||
        (!afterStop && current.control.generation !== tab.controlGeneration) ||
        !current.control.ownedByCaller ||
        current.control.owner === "human"
      )
        return yield* Effect.die(new Error("Tab control changed before cleanup"));
      const closed = yield* broker
        .invoke({
          scope,
          operation: "close",
          input: {},
          exact: {
            ...route,
            controlGeneration: current.control.generation,
            origin: originOf(current.url),
          },
        })
        .pipe(Effect.result);
      if (closed._tag === "Failure" && !(goneErrors.has(closed.failure._tag) && (yield* gone)))
        return yield* closed.failure;
    }).pipe(Effect.orDie);
  };
  const tabScopes = new Map<string, ScreenHostContext["invocation"]>();
  const claims = yield* makeTabClaims(close);
  const authorize = Effect.fn("PreviewTargetHost.authorize")(function* (
    context: ScreenHostContext,
  ) {
    if (!context.invocation.reauthorize)
      return yield* Effect.fail(fail("permission_denied", "Refresh the credential."));
    const result = yield* context.invocation.reauthorize([]).pipe(Effect.result);
    if (result._tag === "Failure" || !context.invocation.capabilities.has("preview"))
      return yield* Effect.fail(fail("permission_denied", "Refresh the preview grant."));
    tabScopes.set(`${context.runId}\u0000${context.turnId}`, context.invocation);
  });
  const list = (context: ScreenHostContext) =>
    authorize(context).pipe(Effect.flatMap(() => broker.listBoundTabs(context.invocation)));
  const identity = (bound: BoundTarget, context: ScreenHostContext): TabIdentity => ({
    environmentId: context.environmentId,
    threadId: context.threadId,
    runId: context.runId,
    turnId: context.turnId,
    browserInstanceId: bound.tab.browserInstanceId,
    connectionId: bound.tab.connectionId,
    tabId: bound.tab.tabId,
    controlGeneration: bound.tab.controlGeneration,
  });
  const bind = (tab: BoundPreviewTab, context: ScreenHostContext): ScreenTargetRef => {
    const ref: ScreenTargetRef = {
      id: NodeCrypto.randomUUID(),
      kind: "tab",
      environmentId: context.environmentId,
      runId: context.runId,
      turnId: context.turnId,
      generation: 0,
    };
    targets.set(ref.id, { ref, tab, origin: originOf(tab.url) });
    return ref;
  };
  const lookup = (call: ScreenHostCall, context: ScreenHostContext) => {
    const ref = call.targetRef;
    const bound = ref ? targets.get(ref.id) : undefined;
    return ref?.kind === "tab" &&
      bound &&
      bound.ref.runId === context.runId &&
      bound.ref.turnId === context.turnId &&
      bound.ref.environmentId === context.environmentId &&
      bound.ref.generation === ref.generation
      ? bound
      : undefined;
  };
  const exact = (tab: BoundPreviewTab, expected = true) => ({
    browserInstanceId: tab.browserInstanceId,
    connectionId: tab.connectionId,
    tabId: tab.tabId,
    ...(expected ? { controlGeneration: tab.controlGeneration, origin: originOf(tab.url) } : {}),
  });
  const status = Effect.fn("PreviewTargetHost.status")(function* (
    bound: BoundTarget,
    context: ScreenHostContext,
  ) {
    const current = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope: context.invocation,
        operation: "status",
        input: {},
        exact: exact(bound.tab, false),
        updateCurrentTab: false,
      })
      .pipe(Effect.mapError(() => fail("unavailable", "Bind the tab again.")));
    if (
      current.tabId !== bound.tab.tabId ||
      !current.control ||
      current.control.generation !== bound.tab.controlGeneration ||
      originOf(current.url) !== bound.origin
    )
      return yield* Effect.fail(fail("stale_reference", "Bind and observe the tab again."));
    return current;
  });
  const invoke = (
    bound: BoundTarget,
    context: ScreenHostContext,
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
  ) =>
    broker.invoke({ scope: context.invocation, operation, input, exact: exact(bound.tab) }).pipe(
      Effect.mapError(() =>
        operation === "snapshot"
          ? fail("downstream_failure", "Refresh the tab status before retrying.")
          : {
              ...fail("unknown_outcome", "Inspect the tab before any later action."),
              effectStarted: true,
            },
      ),
    );
  const dispatch: ScreenHostDispatcher["dispatch"] = Effect.fn("PreviewTargetHost.dispatch")(
    function* (call, context) {
      yield* authorize(context);
      const arg = firstArg(call);
      if (call.method === "list_tabs") {
        const tabs = yield* list(context);
        return { value: tabs, category: "confirmed", evidence: ["Current bound preview tabs"] };
      }
      if (call.method === "select_tab") {
        const tabs = yield* list(context);
        const tabId = stringField(arg, "tabId");
        const url = stringField(arg, "url");
        const mentionId = stringField(arg, "mentionId");
        const hints = bindingHints.get(turnKey(context));
        const hint = mentionId
          ? hints?.tabs.find((item) => item.mentionId === mentionId)
          : undefined;
        if (mentionId && !hint)
          return yield* Effect.fail(
            fail("unsupported", "The current turn has no matching server-provided tab mention."),
          );
        const candidates = tabs.filter(
          (tab) =>
            (tabId === undefined || tab.tabId === tabId) &&
            (url === undefined || tab.url === url) &&
            // A mention binds by identity; the page may have loaded or navigated since it was made.
            (!hint ||
              (tab.environmentId === hint.environmentId &&
                tab.browserInstanceId === hint.browserInstanceId &&
                tab.tabId === hint.tabId)),
        );
        if ((!tabId && !url && !mentionId) || candidates.length !== 1)
          return yield* Effect.fail(
            fail(
              candidates.length ? "target_ambiguous" : "target_missing",
              "Specify one live tab ID or URL.",
            ),
          );
        const candidate = candidates[0];
        if (!candidate) return yield* Effect.fail(fail("target_missing", "Find the tab again."));
        const ref = bind(candidate, context);
        return {
          value: { targetRef: ref, tab: candidate },
          category: "confirmed",
          evidence: ["Exact tab bound"],
        };
      }
      if (call.method === "open_tab") {
        // Once the browser may have opened the tab, a cutoff must not stop us claiming it, and a
        // tab that cannot be claimed is closed, so no agent tab escapes turn cleanup.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const opened = yield* broker
              .invoke<PreviewAutomationStatus>({
                scope: context.invocation,
                operation: "open",
                serverHostOnly: true,
                input: {
                  ...(stringField(arg, "url") ? { url: arg.url } : {}),
                  reuseExistingTab: false,
                },
              })
              .pipe(
                Effect.mapError(() => ({
                  ...fail("unknown_outcome", "Check live tabs before opening again."),
                  effectStarted: true,
                })),
              );
            const abandon = (nextStep: string) =>
              broker
                .invoke({
                  scope: context.invocation,
                  operation: "close",
                  input: {},
                  ...(opened.tabId ? { tabId: opened.tabId } : {}),
                })
                .pipe(
                  // A refused close (a person viewing it, or a focused secret field) leaves the
                  // tab to the browser's idle sweep, which closes unviewed agent tabs.
                  Effect.catchCause((cause) =>
                    Effect.logWarning("screen code could not close an unclaimed new tab", {
                      cause,
                    }),
                  ),
                  Effect.andThen(
                    Effect.fail({ ...fail("unknown_outcome", nextStep), effectStarted: true }),
                  ),
                );
            const tabs = yield* list(context).pipe(
              Effect.catchCause(() => abandon("Reconcile the opened tab in preview status.")),
            );
            const tab = tabs.find((entry) => entry.tabId === opened.tabId);
            if (!tab) return yield* abandon("Reconcile the opened tab in preview status.");
            const ref = bind(tab, context);
            const openedBound = targets.get(ref.id);
            if (!openedBound) return yield* abandon("Reconcile the new tab.");
            yield* claims
              .recordOpened(identity(openedBound, context))
              .pipe(Effect.catchCause(() => abandon("The new tab could not be claimed.")));
            return {
              value: { targetRef: ref, tab },
              category: "confirmed" as const,
              evidence: ["New preview tab opened"],
            };
          }),
        );
      }
      const bound = lookup(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference", "Bind the tab again."));
      const current = yield* status(bound, context);
      const claimIdentity = identity(bound, context);
      if (call.method === "claim_tab") {
        const claim = yield* claims
          .acquireTab({
            ...claimIdentity,
            owner: current.control?.owner ?? "human",
            ownedByCaller: current.control?.ownedByCaller ?? false,
          })
          .pipe(
            Effect.mapError(() =>
              fail("permission_denied", "This tab is already controlled or claimed."),
            ),
          );
        return { value: claim, category: "confirmed", evidence: ["Turn claim acquired"] };
      }
      if (call.method === "keep_tab") {
        const reason = arg.reason === "handoff" ? ("handoff" as const) : ("deliverable" as const);
        yield* claims
          .keep(claimIdentity, reason)
          .pipe(Effect.mapError(() => fail("stale_reference", "Claim the tab again.")));
        return {
          value: { kept: true },
          category: "confirmed",
          evidence: ["Tab retained at turn end"],
        };
      }
      if (call.method === "observe") {
        const snapshot = yield* invoke(bound, context, "snapshot", {
          captureImage: arg.screenshot === true,
          fullPage: arg.fullPage === true,
        }) as Effect.Effect<PreviewAutomationSnapshot, ScreenRunError>;
        const draft = observations.normalizeTabSnapshot({
          targetRef: bound.ref,
          targetGeneration: bound.ref.generation,
          connectionId: bound.tab.connectionId,
          controlGeneration: bound.tab.controlGeneration,
          snapshot,
        });
        const mode = arg.mode === "diff" || arg.mode === "query" ? arg.mode : "full";
        const query =
          arg.query && typeof arg.query === "object"
            ? (arg.query as { role?: string; name?: string; text?: string })
            : undefined;
        const baseObservationId = stringField(arg, "baseObservationId");
        const screenshot = snapshot.screenshot;
        const shot =
          screenshot && screenshot.region && screenshot.scale && screenshot.data
            ? {
                ...screenshot,
                region: screenshot.region,
                scale: screenshot.scale,
                data: screenshot.data,
              }
            : undefined;
        const imageRef = NodeCrypto.randomUUID();
        const regionId = NodeCrypto.randomUUID();
        const imageMetadata = (observationId: string): ScreenImageMetadata | undefined =>
          shot && {
            imageRef,
            callId: call.callId,
            targetId: bound.ref.id,
            observationId,
            regionId,
            region: shot.region,
            pixelWidth: shot.width,
            pixelHeight: shot.height,
            scale: shot.scale,
            mimeType: shot.mimeType,
          };
        // The reply carries the image metadata beside the tree, so the tree leaves room for its
        // largest form. Observation ids are UUIDs, so a fresh one measures the same.
        const reserved = imageMetadata(NodeCrypto.randomUUID());
        const imageReserve = reserved
          ? // @effect-diagnostics-next-line preferSchemaOverJson:off -- measures the bytes the reply will carry.
            Buffer.byteLength(JSON.stringify({ image: { ...reserved, omitted: true } }))
          : 0;
        const observation = yield* Effect.try({
          try: () =>
            observations.renderObservation({
              draft,
              mode,
              ...(baseObservationId ? { baseObservationId } : {}),
              ...(query ? { query } : {}),
              limits: { treeBytes: observationReplyBudget(call, context.limits, imageReserve) },
            }),
          catch: (cause) =>
            fail(
              cause instanceof Error &&
                cause.message === "Screen observation metadata exceeds tree budget"
                ? "tree_limit"
                : "downstream_failure",
              "Observe a smaller tab region and retry.",
            ),
        });
        const metadata = imageMetadata(observation.observationId);
        if (!shot || !metadata) {
          return {
            value: observation,
            category: "confirmed",
            evidence: ["Current tab tree observed"],
          };
        }
        observations.index.putRegion(bound.ref.id, observation.observationId, metadata.regionId, {
          ...metadata.region,
          pixelWidth: metadata.pixelWidth,
          pixelHeight: metadata.pixelHeight,
          scale: metadata.scale,
        });
        if (Buffer.from(shot.data, "base64").byteLength > context.limits.imageBytes)
          return {
            value: { ...observation, image: { ...metadata, omitted: true } },
            category: "partial",
            evidence: ["Image exceeded the cell limit"],
          };
        const image: ScreenImage = { ...metadata, bytes: shot.data };
        return {
          value: { ...observation, image: metadata },
          image,
          imageMetadata: metadata,
          category: "confirmed",
          evidence: ["Current tab tree and image observed"],
        };
      }
      const actions: Record<string, Parameters<typeof broker.invoke>[0]["operation"]> = {
        click: "click",
        right_click: "click",
        drag: "drag",
        scroll: "scroll",
        select: "select",
        set_value: "type",
        type_text: "type",
        press_key: "press",
        wait_for: "waitFor",
        navigate_tab: "navigate",
        reload_tab: "reload",
        back_tab: "back",
        forward_tab: "forward",
        close_tab: "close",
      };
      const operation = actions[call.method];
      if (!operation || call.method === "select_text")
        return yield* Effect.fail(fail("unsupported", "This tab operation is unavailable."));
      if (call.method !== "wait_for") {
        yield* claims
          .assertCurrent(claimIdentity)
          .pipe(
            Effect.mapError(() => fail("permission_denied", "Claim the tab before changing it.")),
          );
      }
      const locator =
        arg.ref && typeof arg.ref === "object"
          ? observations.index.resolveElement(
              arg.ref as Parameters<typeof observations.index.resolveElement>[0],
            )
          : undefined;
      if (arg.ref && !locator)
        return yield* Effect.fail(fail("stale_reference", "Observe the current tab again."));
      if (
        call.method === "set_value" &&
        (!arg.ref ||
          !observations.index.isEditable(
            arg.ref as Parameters<typeof observations.index.isEditable>[0],
          ))
      )
        return yield* Effect.fail(
          fail("unsupported", "Observe an editable tab element before setting its value."),
        );
      const point =
        arg.point && typeof arg.point === "object"
          ? observations.index.resolvePoint(
              arg.point as Parameters<typeof observations.index.resolvePoint>[0],
            )
          : undefined;
      if (arg.point && (!point || point.targetId !== bound.ref.id))
        return yield* Effect.fail(fail("stale_reference", "Observe the current screenshot again."));
      if ((arg.x !== undefined || arg.y !== undefined) && !point)
        return yield* Effect.fail(
          fail("invalid_argument", "Use a point from the current screenshot."),
        );
      if (call.method === "close_tab") {
        const claim = yield* claims
          .assertCurrent(claimIdentity)
          .pipe(Effect.mapError(() => fail("permission_denied", "Claim this tab first.")));
        if (claim.provenance !== "agent-created")
          return yield* Effect.fail(
            fail("permission_denied", "Only tabs opened by this run can be closed."),
          );
      }
      let input: Record<string, unknown> = {};
      switch (call.method) {
        case "click":
        case "right_click": {
          if (!locator && !point)
            return yield* Effect.fail(
              fail("invalid_argument", "Use a current element or image point."),
            );
          input = {
            ...(locator ? { locator } : { x: point?.x, y: point?.y }),
            ...(call.method === "right_click" ? { button: "right" } : {}),
          };
          break;
        }
        case "drag": {
          const source =
            arg.sourceRef && typeof arg.sourceRef === "object"
              ? observations.index.resolveElement(
                  arg.sourceRef as Parameters<typeof observations.index.resolveElement>[0],
                )
              : undefined;
          const target =
            arg.targetRef && typeof arg.targetRef === "object"
              ? observations.index.resolveElement(
                  arg.targetRef as Parameters<typeof observations.index.resolveElement>[0],
                )
              : undefined;
          if (!source || !target)
            return yield* Effect.fail(fail("stale_reference", "Observe both drag elements again."));
          input = { source, target };
          break;
        }
        case "scroll":
          input = {
            ...(locator ? { locator } : {}),
            deltaX: typeof arg.deltaX === "number" ? arg.deltaX : 0,
            deltaY: typeof arg.deltaY === "number" ? arg.deltaY : 0,
          };
          break;
        case "select":
          if (
            !locator ||
            !Array.isArray(arg.values) ||
            !arg.values.every((value) => typeof value === "string")
          )
            return yield* Effect.fail(
              fail("invalid_argument", "Select values on a current select element."),
            );
          input = { locator, values: arg.values };
          break;
        case "set_value":
        case "type_text":
          input = {
            ...(locator ? { locator } : {}),
            text: stringField(arg, "text") ?? "",
            ...(call.method === "set_value" ? { clear: true } : {}),
          };
          break;
        case "press_key":
          if (!stringField(arg, "key"))
            return yield* Effect.fail(fail("invalid_argument", "Provide a key."));
          input = {
            key: arg.key,
            ...(Array.isArray(arg.modifiers) ? { modifiers: arg.modifiers } : {}),
          };
          break;
        case "wait_for":
          input = {
            ...(locator ? { locator } : {}),
            ...(stringField(arg, "text") ? { text: arg.text } : {}),
            ...(stringField(arg, "urlIncludes") ? { urlIncludes: arg.urlIncludes } : {}),
            ...(stringField(arg, "loadState") ? { loadState: arg.loadState } : {}),
          };
          if (Object.keys(input).length === 0)
            return yield* Effect.fail(fail("invalid_argument", "Provide a wait condition."));
          break;
        case "navigate_tab":
          if (!stringField(arg, "url"))
            return yield* Effect.fail(fail("invalid_argument", "Provide a URL."));
          input = { url: arg.url };
          break;
      }
      if (call.method === "wait_for") {
        const now = yield* Clock.currentTimeMillis;
        const waited = yield* broker
          .invoke({
            scope: context.invocation,
            operation: "waitFor",
            input,
            exact: exact(bound.tab),
            timeoutMs: Math.max(1, Math.min(context.limits.cellWallMs, call.deadlineMillis - now)),
          })
          .pipe(Effect.result);
        const waitStatus =
          waited._tag === "Success"
            ? "met"
            : waited.failure._tag === "PreviewAutomationTimeoutError"
              ? "timeout"
              : "interrupted";
        return {
          value: { status: waitStatus },
          category: waitStatus === "met" ? "confirmed" : "partial",
          evidence: [`Wait ${waitStatus}`],
        };
      }
      const ownClose =
        call.method === "close_tab" ? closingKey(bound.tab.threadId, bound.tab.tabId) : undefined;
      if (ownClose) closingTabs.set(ownClose, (closingTabs.get(ownClose) ?? 0) + 1);
      const result = yield* invoke(bound, context, operation, input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!ownClose) return;
            const count = (closingTabs.get(ownClose) ?? 1) - 1;
            if (count > 0) closingTabs.set(ownClose, count);
            else closingTabs.delete(ownClose);
          }),
        ),
      );
      observations.evictTarget(bound.ref.id);
      if (call.method === "close_tab") {
        yield* claims.releaseClaim(claimIdentity).pipe(Effect.orElseSucceed(() => undefined));
        targets.delete(bound.ref.id);
      }
      return { value: result, category: "confirmed", evidence: ["Preview operation completed"] };
    },
  );
  const availability: ScreenHostDispatcher["availability"] = Effect.fn(
    "PreviewTargetHost.availability",
  )(function* (context) {
    const available = yield* list(context).pipe(Effect.option);
    return [
      {
        kind: "tab" as const,
        available: Option.isSome(available) && available.value.length > 0,
        ...(Option.isSome(available) && available.value.length > 0
          ? {}
          : { reason: "no_host" as const }),
      },
    ];
  });
  const finishTurn = Effect.fn("PreviewTargetHost.finishTurn")(function* (
    input: Pick<ScreenHostContext, "runId" | "turnId">,
  ) {
    const authority = yield* claims.captureCleanup(input);
    const outcomes = yield* claims.releaseTurn(input, authority);
    tabScopes.delete(`${input.runId}\u0000${input.turnId}`);
    bindingHints.delete(turnKey(input));
    for (const [id, target] of targets)
      if (target.ref.runId === input.runId && target.ref.turnId === input.turnId) {
        observations.evictTarget(id);
        targets.delete(id);
      }
    return outcomes;
  });
  const releaseControl = Effect.fn("PreviewTargetHost.releaseControl")(function* (
    input: Pick<ScreenHostContext, "runId" | "turnId"> & { tabId?: string },
  ) {
    const authority = yield* claims.captureCleanup(input, {
      fence: false,
      afterStop: true,
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    });
    return yield* claims.releaseTurn(input, authority);
  });
  const setBindingHints = (
    identity: Pick<ScreenHostContext, "runId" | "turnId">,
    hints: ScreenBindingHints,
  ) => {
    bindingHints.set(turnKey(identity), hints);
  };
  const invalidateTarget = (targetId: string) => {
    observations.evictTarget(targetId);
    targets.delete(targetId);
  };
  return {
    availability,
    dispatch,
    finishTurn,
    releaseControl,
    setBindingHints,
    invalidateTarget,
    isClosingOwnTab,
  };
});
