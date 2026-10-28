import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type {
  PreviewAutomationBroker,
  PreviewAutomationInvokeInput,
} from "../mcp/PreviewAutomationBroker.ts";

/** The exact server tab a screen run observed; the broker routes only to that live connection. */
export interface ExactPreviewTab {
  readonly browserInstanceId: string;
  readonly connectionId: string;
  readonly tabId: PreviewTabId;
  readonly controlGeneration?: number;
  readonly origin?: string | null;
  readonly documentGeneration?: number;
}

export interface BoundPreviewTab {
  readonly environmentId: string;
  readonly browserInstanceId: string;
  readonly connectionId: string;
  readonly threadId: string;
  readonly tabId: PreviewTabId;
  readonly title: string | null;
  readonly url: string | null;
  readonly owner: NonNullable<PreviewAutomationStatus["control"]>["owner"];
  readonly ownedByCaller: boolean;
  readonly controlGeneration: number;
}

interface ScreenHost {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: string;
  readonly liveTabs: ReadonlyArray<{ readonly threadId: string; readonly tabId: PreviewTabId }>;
}

type Supports<Host> = (host: Host, operation: PreviewAutomationOperation) => boolean;

/**
 * The only connection an exact or server-host-only request may use, or undefined for any other
 * request. Neither kind falls back to another host.
 */
export const screenConnection = <Host extends ScreenHost>(
  clients: ReadonlyMap<string, Host>,
  input: Pick<PreviewAutomationInvokeInput, "scope" | "operation" | "exact" | "serverHostOnly">,
  supports: (host: Host) => boolean,
): { readonly connection: Host | undefined } | undefined => {
  const exact = input.exact;
  if (exact) {
    const host = clients.get(exact.browserInstanceId);
    return {
      connection:
        host?.connectionId === exact.connectionId &&
        host.environmentId === input.scope.environmentId &&
        host.clientId === SERVER_BROWSER_AUTOMATION_CLIENT_ID &&
        supports(host) &&
        host.liveTabs.some(
          (tab) => tab.threadId === input.scope.thread.threadId && tab.tabId === exact.tabId,
        )
          ? host
          : undefined,
    };
  }
  if (!input.serverHostOnly) return undefined;
  const host = clients.get(SERVER_BROWSER_AUTOMATION_CLIENT_ID);
  return {
    connection:
      host?.environmentId === input.scope.environmentId && supports(host) ? host : undefined,
  };
};

/** The server tab rechecks this; only an exact target with an observed generation and origin sends it. */
export const screenExpectationOf = (exact: ExactPreviewTab | undefined) =>
  exact?.controlGeneration === undefined || exact.origin === undefined
    ? {}
    : {
        screenExpectation: {
          browserInstanceId: exact.browserInstanceId,
          connectionId: exact.connectionId,
          controlGeneration: exact.controlGeneration,
          origin: exact.origin,
          ...(exact.documentGeneration === undefined
            ? {}
            : { documentGeneration: exact.documentGeneration }),
        },
      };

export type ListBoundTabs = (
  scope: McpInvocationContext.McpThreadInvocationScope,
) => Effect.Effect<readonly BoundPreviewTab[]>;

/** Lists this thread's server tabs that still answer status on the connection that listed them. */
export const makeListBoundTabs = <Host extends ScreenHost>(options: {
  readonly hosts: Effect.Effect<ReadonlyMap<string, Host>>;
  readonly supports: Supports<Host>;
  readonly invoke: PreviewAutomationBroker["Service"]["invoke"];
}): ListBoundTabs =>
  Effect.fn("PreviewAutomationBroker.listBoundTabs")(function* (scope) {
    const candidates = [...(yield* options.hosts).values()].flatMap((host) =>
      host.environmentId === scope.environmentId &&
      host.clientId === SERVER_BROWSER_AUTOMATION_CLIENT_ID &&
      options.supports(host, "status")
        ? host.liveTabs
            .filter((tab) => tab.threadId === scope.thread.threadId)
            .map((tab) => ({
              browserInstanceId: host.clientId,
              connectionId: host.connectionId,
              tabId: tab.tabId,
            }))
        : [],
    );
    const found: BoundPreviewTab[] = [];
    for (const candidate of candidates) {
      const result = yield* options
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "status",
          input: {},
          exact: candidate,
          updateCurrentTab: false,
        })
        .pipe(Effect.option);
      if (Option.isNone(result)) continue;
      const status = result.value;
      if (status.tabId !== candidate.tabId || !status.control) continue;
      const live = yield* options.hosts;
      if (live.get(candidate.browserInstanceId)?.connectionId !== candidate.connectionId) continue;
      found.push({
        environmentId: scope.environmentId,
        browserInstanceId: candidate.browserInstanceId,
        connectionId: candidate.connectionId,
        threadId: scope.thread.threadId,
        tabId: candidate.tabId,
        title: status.title,
        url: status.url,
        owner: status.control.owner,
        ownedByCaller: status.control.ownedByCaller,
        controlGeneration: status.control.generation,
      });
    }
    return found;
  });
