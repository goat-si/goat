import type { PreviewAutomationStatus, PreviewTabId, ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BoundPreviewTab } from "./BoundPreviewTabs.ts";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
import type { TabClaim } from "./TabClaims.ts";

export const originOf = (url: string | null) => {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
};

/** Turn cleanup's close of one claimed tab, refusing a tab whose control changed since its claim. */
export const makeTurnTabClose = (
  broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs">,
  tabScopes: ReadonlyMap<string, ScreenHostContext["invocation"]>,
) => {
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
      // Handed to a person for a step: it outlives the turn, as a tab kept for handoff does.
      if (current.tabId === tab.tabId && current.control?.waitingForPerson === true)
        return "kept" as const;
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
  return close;
};

/**
 * An open whose page never connected left a tab on the browser's error page. It is claimed for the
 * turn first, so turn cleanup still owns it if this close fails, then closed through the normal
 * close and confirmed gone. The answer names the network error, and the tab id while it stays.
 */
export const settleUnloadedOpen = Effect.fn("PreviewTabCleanup.settleUnloadedOpen")(
  function* (input: {
    readonly broker: Pick<PreviewAutomationBroker["Service"], "invoke">;
    readonly invocation: ScreenHostContext["invocation"];
    readonly tabId: PreviewTabId;
    readonly loadError: string;
    /** The browser that answered the open; status and close go only to it. */
    readonly route: { readonly browserInstanceId: string; readonly connectionId: string };
    /** The live tabs, or none when they could not be listed. */
    readonly list: Effect.Effect<Option.Option<ReadonlyArray<BoundPreviewTab>>>;
    /** Claims the tab for the turn; false when no claim could be recorded. */
    readonly claim: (tab: BoundPreviewTab) => Effect.Effect<boolean>;
    readonly release: (tabId: string) => Effect.Effect<void>;
  }) {
    const listed = yield* input.list;
    const tab = Option.isSome(listed)
      ? listed.value.find((entry) => entry.tabId === input.tabId)
      : undefined;
    const route = tab
      ? { browserInstanceId: tab.browserInstanceId, connectionId: tab.connectionId }
      : input.route;
    const claimed = tab ? yield* input.claim(tab) : false;
    const closed = yield* input.broker
      .invoke({
        scope: input.invocation,
        operation: "close",
        input: {},
        exact: {
          ...route,
          tabId: input.tabId,
          ...(tab ? { controlGeneration: tab.controlGeneration, origin: originOf(tab.url) } : {}),
        },
      })
      .pipe(Effect.isSuccess);
    // The list leaves out a tab whose status it could not read, so the tab counts as closed only
    // when that same browser says it has no such tab, or accepted the close and no longer routes
    // to the tab (a closed tab leaves the host's live tabs, which answers NoAvailableHost).
    const gone = yield* input.broker
      .invoke<PreviewAutomationStatus>({
        scope: input.invocation,
        operation: "status",
        input: {},
        exact: { ...route, tabId: input.tabId },
        updateCurrentTab: false,
      })
      .pipe(
        Effect.match({
          onFailure: (error) =>
            error._tag === "PreviewAutomationTabNotFoundError" ||
            (closed && error._tag === "PreviewAutomationNoAvailableHostError"),
          onSuccess: (status) => status.tabId !== input.tabId,
        }),
      );
    const reason = `Could not connect (${input.loadError})`;
    if (!gone)
      return {
        code: "downstream_failure" as const,
        effectStarted: true,
        message: `${reason}; its tab ${input.tabId} is still open.`,
        nextStep: `screen.tab({tabId: "${input.tabId}"}) shows it; close it there${claimed ? " or leave it to turn cleanup" : ""}.`,
      } satisfies ScreenRunError;
    yield* input.release(input.tabId);
    return {
      code: "downstream_failure" as const,
      effectStarted: false,
      message: `${reason}; the tab this call opened was closed.`,
      nextStep: "Start the page's server or fix the address, then open it again.",
    } satisfies ScreenRunError;
  },
);
