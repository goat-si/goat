import { classifyBrowserActionOutcome } from "../preview/actionOutcomeSafety.ts";
// @effect-diagnostics nodeBuiltinImport:off - Target and image IDs are host-owned opaque values.
import * as NodeCrypto from "node:crypto";
import type {
  ScreenBindingHints,
  ScreenHostCall,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import type { PreviewAutomationSnapshot, PreviewAutomationStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import type { BoundPreviewTab } from "./BoundPreviewTabs.ts";
import { ComputerUseCallApps } from "../cua/ComputerUseCallApps.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  observationReplyBudget,
  type ScreenHostContext,
  type ScreenHostDispatcher,
} from "./ScreenHostBridge.ts";
import { cellReadInput, cellScope, observePreviewTarget } from "./PreviewTargetReads.ts";
import { withInputTiming } from "./DesktopWindows.ts";
import { nonWebUrl, pointerInput, waitConditions, WEB_ONLY } from "./PreviewTabInputs.ts";
import { makeTurnTabClose, originOf, settleUnloadedOpen } from "./PreviewTabCleanup.ts";
import { previewTargetFailure } from "./PreviewTargetFailures.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { makeTabClaims, type TabIdentity } from "./TabClaims.ts";

const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});
const firstArg = (call: ScreenHostCall): Record<string, unknown> => {
  const value = Array.isArray(call.args) ? call.args[0] : undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};
const stringField = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;
/** A wait without its own timeout gets the browser's usual one. */
const DEFAULT_WAIT_MS = 15_000;
// What a wait leaves of its cell: the browser answers a wait that never started 500 ms after the
// wait's own deadline (CaptureLock.answerCall), and that answer must still travel back.
const WAIT_ANSWER_RESERVE_MS = 1_500;

interface BoundTarget {
  readonly ref: ScreenTargetRef;
  readonly tab: BoundPreviewTab;
  readonly origin: string | null;
  readonly observationId?: string;
  /** The document the latest observation saw, when the host reports one; points belong to it. */
  readonly documentGeneration?: number;
  /** The latest observation, when its tree was incomplete: its refs are held to its document. */
  readonly incompleteObservationId?: string;
  readonly screenshotBasis?: {
    readonly documentGeneration?: number;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly viewportReported: boolean;
  };
}

/** Constructs a tab dispatcher with its own turn-scoped opaque binding and claim tables. */
export const makePreviewTargetHost = Effect.fn("PreviewTargetHost.make")(function* (
  broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> &
    Partial<Pick<PreviewAutomationBroker["Service"], "canOpenTab">>,
) {
  const observations = new ScreenObservations();
  const callApps = yield* ComputerUseCallApps;
  const targets = new Map<string, BoundTarget>();
  let epoch = 0;
  const bindingHints = new Map<string, ScreenBindingHints>();
  const turnKey = (identity: Pick<ScreenHostContext, "runId" | "turnId">) =>
    `${identity.runId}\u0000${identity.turnId}`;
  // ServerBrowser reports a close as a Stop on that tab before the close replies. Marking our own
  // close lets ScreenRunService ignore that report instead of cutting the cell that asked for it.
  const closingTabs = new Map<string, number>();
  const closingKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;
  const isClosingOwnTab = (threadId: string, tabId: string) =>
    closingTabs.has(closingKey(threadId, tabId));
  const tabScopes = new Map<string, ScreenHostContext["invocation"]>();
  const close = makeTurnTabClose(broker, tabScopes);
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
      generation: ++epoch,
    };
    targets.set(ref.id, { ref, tab, origin: originOf(tab.url) });
    callApps.screenTarget(ref.id, { kind: "tab", pageUrl: tab.url }, context);
    return ref;
  };
  /** Drops this turn's bindings and claim of a tab that is gone. */
  const forgetTab = (tabId: string, context: ScreenHostContext) =>
    Effect.forEach(
      [...targets.values()].filter(
        (target) =>
          target.tab.tabId === tabId &&
          target.ref.runId === context.runId &&
          target.ref.turnId === context.turnId,
      ),
      (target) => {
        observations.evictTarget(target.ref.id);
        targets.delete(target.ref.id);
        return claims.releaseClaim(identity(target, context)).pipe(Effect.ignore);
      },
      { discard: true },
    );
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
    readOnly: boolean,
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
      current.control.generation !== bound.tab.controlGeneration
    )
      return yield* Effect.fail(fail("stale_reference", "Bind and observe the tab again."));
    callApps.screenTarget(bound.ref.id, { kind: "tab", pageUrl: current.url }, context);
    if (originOf(current.url) !== bound.origin) {
      observations.evictTarget(bound.ref.id);
      if (!readOnly)
        return yield* Effect.fail(
          fail("stale_reference", "Observe the current tab before sending more input."),
        );
    }
    return current;
  });
  const invoke = (
    bound: BoundTarget,
    context: ScreenHostContext,
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    timeoutMs?: number,
    documentGeneration?: number,
  ) =>
    broker
      .invoke({
        scope: context.invocation,
        operation,
        input,
        exact: {
          ...exact(bound.tab),
          ...(documentGeneration === undefined ? {} : { documentGeneration }),
        },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      .pipe(
        Effect.mapError((error) => {
          const safety = classifyBrowserActionOutcome({
            operation,
            status: "failed",
            errorTag: error._tag,
            ...(error._tag === "PreviewAutomationControlInterruptedError"
              ? { controlReason: error.reason }
              : {}),
            ...("dispatched" in error && error.dispatched !== undefined
              ? { dispatched: error.dispatched }
              : {}),
          });
          const failure = previewTargetFailure(error, operation);
          return {
            ...failure,
            code: safety.possibleCommit
              ? ("unknown_outcome" as const)
              : failure.code === "target_ambiguous" ||
                  failure.code === "invalid_argument" ||
                  failure.code === "blocked_url"
                ? failure.code
                : ("downstream_failure" as const),
            effectStarted: safety.possibleCommit,
            safety,
          };
        }),
      );
  const dispatch: ScreenHostDispatcher["dispatch"] = Effect.fn("PreviewTargetHost.dispatch")(
    function* (call, context) {
      const calledAt = yield* Clock.currentTimeMillis;
      yield* authorize(context);
      const arg = firstArg(call);
      if (call.method === "list_tabs") {
        const tabs = yield* list(context);
        return { value: tabs, category: "confirmed", evidence: ["Current bound preview tabs"] };
      }
      if (call.method === "select_tab") {
        const tabs = yield* list(context);
        // A tab target's identity from an earlier cell of this turn names its tab again.
        const identity = stringField(arg, "identity");
        const tabId =
          stringField(arg, "tabId") ?? (identity ? targets.get(identity)?.tab.tabId : undefined);
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
              identity && !tabId
                ? "That tab target is not bound in this turn; use its tabId or screen.listTabs()."
                : "Specify one live tab ID or URL.",
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
        if (nonWebUrl(arg.url)) return yield* Effect.fail(fail("unsupported", WEB_ONLY));
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
                Effect.catch((error) =>
                  error._tag === "PreviewAutomationExecutionError" &&
                  error.unloadedTab !== undefined
                    ? // The page never connected: close the tab it left, so no error page stays behind.
                      settleUnloadedOpen({
                        broker,
                        invocation: context.invocation,
                        tabId: error.unloadedTab.tabId,
                        loadError: error.unloadedTab.loadError,
                        route: {
                          browserInstanceId: error.clientId,
                          connectionId: error.connectionId,
                        },
                        list: list(context).pipe(Effect.option),
                        claim: (tab) => {
                          const claimed = targets.get(bind(tab, context).id);
                          return claimed
                            ? claims.recordOpened(identity(claimed, context)).pipe(Effect.isSuccess)
                            : Effect.succeed(false);
                        },
                        release: (tabId) => forgetTab(tabId, context),
                      }).pipe(Effect.flatMap(Effect.fail))
                    : Effect.fail({
                        ...fail("unknown_outcome", "Check live tabs before opening again."),
                        effectStarted: true,
                      }),
                ),
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
              outcome: { dispatch: "confirmed", effect: "confirmed" } as const,
            };
          }),
        );
      }
      const bound = lookup(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference", "Bind the tab again."));
      if (call.method === "tab_status") {
        const rawArg =
          Array.isArray(call.args) && call.args.length === 1 ? call.args[0] : undefined;
        if (
          !rawArg ||
          typeof rawArg !== "object" ||
          Array.isArray(rawArg) ||
          Object.keys(rawArg).some((key) => key !== "targetRef")
        )
          return yield* Effect.fail(fail("invalid_argument", "Tab status accepts no options."));
      }
      const current = yield* status(
        bound,
        context,
        call.method === "observe" ||
          call.method === "tab_status" ||
          call.method === "read_page" ||
          call.method === "wait_for",
      );
      if (call.method === "tab_status")
        return { value: current, category: "confirmed", evidence: ["Current tab status observed"] };
      if (call.method === "read_page") {
        const scope = cellScope(arg.scope, observations);
        const read = cellReadInput(arg, observationReplyBudget(call, context.limits));
        if (scope && "code" in scope) return yield* Effect.fail(scope);
        if ("error" in read) return yield* Effect.fail(read.error);
        const page = yield* broker
          .invoke({
            scope: context.invocation,
            operation: "read",
            input: { ...read.input, ...(scope ? { scope } : {}) },
            exact: exact(bound.tab, false),
            updateCurrentTab: false,
          })
          .pipe(Effect.mapError((error) => previewTargetFailure(error, "read")));
        return { value: page, category: "confirmed", evidence: ["Rendered page text read"] };
      }
      if (call.method === "fetch_tab") {
        const url = stringField(arg, "url");
        if (!url) return yield* Effect.fail(fail("invalid_argument", "Provide a URL to fetch."));
        const fetched = yield* broker
          .invoke({
            scope: context.invocation,
            operation: "fetch",
            input: {
              url,
              ...(arg.format === "text" || arg.format === "markdown" ? { format: arg.format } : {}),
              ...(typeof arg.maxChars === "number" ? { maxChars: arg.maxChars } : {}),
            },
            exact: exact(bound.tab, false),
            updateCurrentTab: false,
          })
          .pipe(Effect.mapError((error) => previewTargetFailure(error, "fetch")));
        return { value: fetched, category: "confirmed", evidence: ["Fetched inside the tab"] };
      }
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
        const scope = cellScope(arg.scope, observations);
        if (scope && "code" in scope) return yield* Effect.fail(scope);
        const reading = {
          ...bound,
          tab: { ...bound.tab, url: current.url },
          origin: originOf(current.url),
        };
        observations.index.invalidateTarget(bound.ref.id);
        const sentAt = yield* Clock.currentTimeMillis;
        const snapshot = yield* invoke(reading, context, "snapshot", {
          captureImage: arg.screenshot === true,
          fullPage: arg.fullPage === true,
          ...(arg.interactiveOnly === true ? { interactiveOnly: true } : {}),
          ...(scope ? { scope } : {}),
        }) as Effect.Effect<PreviewAutomationSnapshot, ScreenRunError>;
        const snapshotMs = (yield* Clock.currentTimeMillis) - sentAt;
        const result = yield* observePreviewTarget({
          call,
          context,
          startedAt: calledAt,
          driverMs: snapshotMs,
          targetRef: bound.ref,
          connectionId: bound.tab.connectionId,
          controlGeneration: bound.tab.controlGeneration,
          ...(current.documentGeneration === undefined
            ? {}
            : { documentGeneration: current.documentGeneration }),
          snapshot,
          observations,
          arg: { ...arg, baseObservationId: arg.baseObservationId ?? bound.observationId },
        });
        const image = result.value.image;
        const screenshotBasis =
          image?.region.kind === "viewport"
            ? {
                ...(current.documentGeneration === undefined
                  ? {}
                  : { documentGeneration: current.documentGeneration }),
                viewport: { width: image.region.width, height: image.region.height },
                viewportReported: current.viewport !== undefined,
              }
            : undefined;
        const {
          incompleteObservationId: _previous,
          documentGeneration: _previousDocument,
          screenshotBasis: _previousBasis,
          ...kept
        } = reading;
        targets.set(bound.ref.id, {
          ...kept,
          observationId: result.value.observationId,
          ...(current.documentGeneration === undefined
            ? {}
            : { documentGeneration: current.documentGeneration }),
          ...(screenshotBasis ? { screenshotBasis } : {}),
          ...(result.value.complete || result.value.elements.length === 0
            ? {}
            : { incompleteObservationId: result.value.observationId }),
        });
        return result;
      }
      const actions: Record<string, Parameters<typeof broker.invoke>[0]["operation"]> = {
        click: "click",
        right_click: "click",
        hover: "hover",
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
      const startedAt = yield* Clock.currentTimeMillis;
      // The caller's own tab, such as one goat_preview_open made, needs no separate claim.
      const ownedByCaller = current.control?.ownedByCaller === true;
      if (call.method !== "wait_for") {
        yield* claims.assertCurrent(claimIdentity).pipe(
          Effect.catch(() =>
            ownedByCaller
              ? claims.acquireTab({ ...claimIdentity, owner: "agent", ownedByCaller: true })
              : Effect.fail(undefined),
          ),
          Effect.mapError(() =>
            fail(
              "permission_denied",
              "Call tab.claim() before changing this tab; a tab a person or another agent controls cannot be claimed.",
            ),
          ),
        );
      }
      // A Playwright selector string, or a snapshot ref in it, targets like an observed element.
      const selector = stringField(arg, "selector");
      // A ref acts only through the binding that observed it, which holds its document and gate.
      if (
        [arg.ref, arg.sourceRef, arg.destinationRef].some(
          (ref) =>
            ref !== null &&
            typeof ref === "object" &&
            (ref as { readonly targetId?: unknown }).targetId !== bound.ref.id,
        )
      )
        return yield* Effect.fail(
          fail("stale_reference", "That element belongs to another tab target; observe this one."),
        );
      const locator =
        arg.ref && typeof arg.ref === "object"
          ? observations.index.resolveElement(
              arg.ref as Parameters<typeof observations.index.resolveElement>[0],
            )
          : selector;
      if (arg.ref && !locator)
        return yield* Effect.fail(fail("stale_reference", "Observe the current tab again."));
      if (
        call.method === "set_value" &&
        selector === undefined &&
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
      // The page may have moved on by itself (a redirect, a route change, a reload); a pixel from
      // the earlier document could land on anything.
      if (point && bound.documentGeneration !== current.documentGeneration)
        return yield* Effect.fail(
          fail("stale_reference", "The page changed since that screenshot. Observe it again."),
        );
      if (point && bound.screenshotBasis?.viewportReported) {
        const viewport = bound.screenshotBasis.viewport;
        if (
          !current.viewport ||
          current.viewport.width !== viewport.width ||
          current.viewport.height !== viewport.height
        )
          return yield* Effect.fail(
            fail(
              "stale_reference",
              "The viewport changed since that screenshot. Observe it again.",
            ),
          );
      }
      // A ref from an incomplete tree is held to its document the same way: the browser's ref
      // table alone was never relied on for those.
      const documentBound =
        bound.incompleteObservationId !== undefined &&
        [arg.ref, arg.sourceRef, arg.destinationRef].some(
          (ref) =>
            ref !== null &&
            typeof ref === "object" &&
            (ref as { readonly observationId?: unknown }).observationId ===
              bound.incompleteObservationId,
        );
      if (documentBound && bound.documentGeneration !== current.documentGeneration)
        return yield* Effect.fail(
          fail("stale_reference", "The page changed since that observation. Observe it again."),
        );
      if (point?.kind === "document")
        return yield* Effect.fail(
          fail(
            "unsupported",
            "Full-page image points cannot be clicked safely. Observe a viewport screenshot near the target and use its point or an element ref.",
          ),
        );
      if ((arg.x !== undefined || arg.y !== undefined) && !point)
        return yield* Effect.fail(
          fail("invalid_argument", "Use a point from the current screenshot."),
        );
      // Only a pointer action can aim at a point; typing or keys would go to whatever has focus.
      if (point && !["click", "right_click", "hover", "drag", "scroll"].includes(call.method))
        return yield* Effect.fail(
          fail("invalid_argument", "Click the point first, or name an element or selector."),
        );
      if (call.method === "close_tab") {
        const claim = yield* claims
          .assertCurrent(claimIdentity)
          .pipe(Effect.mapError(() => fail("permission_denied", "Claim this tab first.")));
        if (claim.provenance !== "agent-created" && !ownedByCaller)
          return yield* Effect.fail(
            fail("permission_denied", "Only tabs this agent opened can be closed."),
          );
      }
      let input: Record<string, unknown> = {};
      switch (call.method) {
        case "click":
        case "right_click":
        case "hover": {
          const now = yield* Clock.currentTimeMillis;
          const pointer = pointerInput(
            call.method,
            arg,
            locator ?? point,
            call.deadlineMillis,
            now,
          );
          if ("error" in pointer) return yield* Effect.fail(pointer.error);
          input = pointer.fields;
          break;
        }
        case "drag": {
          if (point) {
            const end =
              arg.toPoint && typeof arg.toPoint === "object"
                ? observations.index.resolvePoint(
                    arg.toPoint as Parameters<typeof observations.index.resolvePoint>[0],
                  )
                : undefined;
            if (!end || end.targetId !== bound.ref.id || end.kind === "document")
              return yield* Effect.fail(
                fail("stale_reference", "Observe a viewport screenshot and use two of its points."),
              );
            input = { from: { x: point.x, y: point.y }, to: { x: end.x, y: end.y } };
            break;
          }
          const source =
            arg.sourceRef && typeof arg.sourceRef === "object"
              ? observations.index.resolveElement(
                  arg.sourceRef as Parameters<typeof observations.index.resolveElement>[0],
                )
              : stringField(arg, "sourceSelector");
          const target =
            arg.destinationRef && typeof arg.destinationRef === "object"
              ? observations.index.resolveElement(
                  arg.destinationRef as Parameters<typeof observations.index.resolveElement>[0],
                )
              : stringField(arg, "destinationSelector");
          if (!source || !target)
            return yield* Effect.fail(fail("stale_reference", "Observe both drag elements again."));
          input = { source, target };
          break;
        }
        case "scroll":
          input = {
            ...(locator ? { locator } : {}),
            ...(point ? { x: point.x, y: point.y } : {}),
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
        case "wait_for": {
          const conditions = waitConditions(arg);
          if ("error" in conditions) return yield* Effect.fail(conditions.error);
          input = {
            ...(locator ? { locator } : {}),
            ...(stringField(arg, "text") ? { text: arg.text } : {}),
            ...(stringField(arg, "urlIncludes") ? { urlIncludes: arg.urlIncludes } : {}),
            ...(stringField(arg, "loadState") ? { loadState: arg.loadState } : {}),
            ...conditions.fields,
          };
          if (Object.keys(input).length === 0)
            return yield* Effect.fail(fail("invalid_argument", "Provide a wait condition."));
          break;
        }
        case "navigate_tab":
          if (!stringField(arg, "url"))
            return yield* Effect.fail(fail("invalid_argument", "Provide a URL."));
          if (nonWebUrl(arg.url)) return yield* Effect.fail(fail("unsupported", WEB_ONLY));
          input = { url: arg.url };
          break;
      }
      // Input waits for its target or a dialog; the request deadline, which the server starts
      // before queueing, ends with the cell so nothing lands after the cell stopped waiting.
      let cellBudgetMs: number | undefined;
      if (["select", "type", "click", "hover", "drag", "scroll"].includes(operation)) {
        const now = yield* Clock.currentTimeMillis;
        // A click or hover asked to wait longer for its target keeps the request open for it.
        const asked =
          operation === "click" || operation === "hover" ? Number(input.timeoutMs) + 500 : 0;
        cellBudgetMs = Math.max(1, Math.min(Math.max(15_000, asked), call.deadlineMillis - now));
        if (operation === "select" || operation === "type")
          input = { ...input, timeoutMs: cellBudgetMs };
      }
      if (call.method === "wait_for") {
        const now = yield* Clock.currentTimeMillis;
        const requested =
          typeof arg.timeoutMs === "number" && arg.timeoutMs > 0 ? arg.timeoutMs : DEFAULT_WAIT_MS;
        const budgetMs = Math.floor(call.deadlineMillis - now - WAIT_ANSWER_RESERVE_MS);
        // Too little of the cell is left for any answer to arrive, so nothing is sent.
        if (budgetMs < 1)
          return yield* Effect.fail(
            fail(
              "deadline",
              "Too little of this cell is left for a wait to answer; wait in a new cell.",
            ),
          );
        const waitMs = Math.max(
          1,
          Math.floor(Math.min(requested, context.limits.cellWallMs, budgetMs)),
        );
        const waited = yield* broker
          .invoke({
            scope: context.invocation,
            operation: "waitFor",
            input,
            // A wait only reads, so it watches whatever document the tab holds, on any origin.
            exact: exact(bound.tab, false),
            timeoutMs: waitMs,
          })
          .pipe(Effect.result);
        // Only the browser saying the condition did not hold in time is an answer to branch on; the
        // broker's own timeout (the host never answered) fails the call like a lost tab.
        const unmet =
          waited._tag === "Failure" &&
          waited.failure._tag === "PreviewAutomationTimeoutError" &&
          waited.failure.remoteTag === "PreviewAutomationTimeoutError";
        if (waited._tag === "Failure" && !unmet)
          return yield* Effect.fail(previewTargetFailure(waited.failure, "waitFor"));
        const waitStatus = waited._tag === "Success" ? "met" : "timeout";
        return {
          value: { status: waitStatus },
          category: waitStatus === "met" ? "confirmed" : "unverifiable",
          evidence: [`Wait ${waitStatus}`],
        };
      }
      const ownClose =
        call.method === "close_tab" ? closingKey(bound.tab.threadId, bound.tab.tabId) : undefined;
      if (ownClose) closingTabs.set(ownClose, (closingTabs.get(ownClose) ?? 0) + 1);
      // Refs outlive completed in-page input, as computer use tokens do: the browser refuses a ref
      // from a replaced document before any input. A failure or a new document retires them.
      // Clicks keep their screenshot basis; inputs that can move the page retire it.
      const retire = Effect.sync(() => observations.index.invalidateTarget(bound.ref.id));
      if (["navigate", "reload", "back", "forward", "close"].includes(operation)) yield* retire;
      else if (!["click", "right_click"].includes(call.method))
        observations.index.invalidatePoints(bound.ref.id);
      // A point, or a ref from an incomplete tree, carries its document so the browser's input
      // gate can refuse it.
      const pointDocument = point || documentBound ? bound.documentGeneration : undefined;
      const sentAt = yield* Clock.currentTimeMillis;
      const result = yield* invoke(
        bound,
        context,
        operation,
        input,
        cellBudgetMs,
        pointDocument,
      ).pipe(
        Effect.tapError(() => retire),
        Effect.ensuring(
          Effect.sync(() => {
            if (!ownClose) return;
            const count = (closingTabs.get(ownClose) ?? 1) - 1;
            if (count > 0) closingTabs.set(ownClose, count);
            else closingTabs.delete(ownClose);
          }),
        ),
      );
      const endedAt = yield* Clock.currentTimeMillis;
      // Navigation answers with the page it reached, as a click that navigated may.
      const reached =
        typeof result === "object" && result !== null ? Reflect.get(result, "url") : undefined;
      if (typeof reached === "string")
        callApps.screenTarget(bound.ref.id, { kind: "tab", pageUrl: reached }, context);
      // The agent moved its own tab, so the handle follows to the page it reached; the old
      // document's refs and points were retired above.
      if (
        ["navigate", "reload", "back", "forward"].includes(operation) &&
        typeof reached === "string"
      )
        targets.set(bound.ref.id, {
          ref: bound.ref,
          tab: { ...bound.tab, url: reached },
          origin: originOf(reached),
        });
      if (call.method === "close_tab") {
        observations.evictTarget(bound.ref.id);
        yield* claims.releaseClaim(claimIdentity).pipe(Effect.orElseSucceed(() => undefined));
        targets.delete(bound.ref.id);
      }
      // A click the browser saw change something is confirmed, and so is a navigation that
      // reached its page; nothing seen stays unverifiable, since late effects can follow, so the
      // cell goes on and one observation settles it. Typed text stays unverifiable: no read the
      // page cannot also produce tells this input's insert from the page's own.
      const seen =
        (operation === "click" || call.method === "set_value") &&
        typeof result === "object" &&
        result !== null
          ? (result as {
              readonly effect?: unknown;
              readonly evidence?: unknown;
              readonly pressesCompleted?: unknown;
            })
          : undefined;
      const navigated = operation === "navigate" && typeof reached === "string";
      // A range the browser set and read back is confirmed; typed text never is, nor a click a
      // dialog cut short of its count.
      const confirmed =
        navigated ||
        (seen?.effect === "confirmed" &&
          seen.pressesCompleted === undefined &&
          Array.isArray(seen.evidence) &&
          (operation === "click" || seen.evidence.includes("value")));
      return {
        value:
          call.method === "close_tab"
            ? result
            : withInputTiming(
                // A click cut short of its count must not read as confirmed in any call form.
                seen?.pressesCompleted === undefined ? result : { ...seen, effect: "unverifiable" },
                { ms: endedAt - startedAt, phases: { driverMs: endedAt - sentAt } },
                context.limits.returnBytes,
              ),
        category: confirmed ? "confirmed" : "unverifiable",
        evidence: navigated
          ? ["navigate:reached", `origin:${originOf(reached) ?? "unknown"}`]
          : confirmed && seen
            ? (seen.evidence as ReadonlyArray<unknown>).map(
                (each) => `${operation === "click" ? "click" : "set_value"}:${String(each)}`,
              )
            : ["dispatched; observe to confirm"],
        safety: classifyBrowserActionOutcome({ operation, status: "completed" }),
        outcome: { dispatch: "confirmed", effect: confirmed ? "confirmed" : "unknown" },
      };
    },
  );
  const availability: ScreenHostDispatcher["availability"] = Effect.fn(
    "PreviewTargetHost.availability",
  )(function* (context) {
    const listed = yield* list(context).pipe(Effect.option);
    // With no tab yet the surface still works when this server's browser can open one.
    const available =
      Option.isSome(listed) &&
      (listed.value.length > 0 ||
        (yield* broker.canOpenTab?.(context.invocation) ?? Effect.succeed(false)));
    return [
      { kind: "tab" as const, available, ...(available ? {} : { reason: "no_host" as const }) },
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
