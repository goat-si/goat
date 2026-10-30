// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Browser action timing uses wall-clock timestamps.
import type { PreviewAutomationActionEvent } from "@goat/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { pushBounded } from "./boundedBuffer.ts";
import { browserFailure, recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";
import type { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";

type Tab = {
  readonly threadId: string;
  readonly page: { readonly url: () => string };
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly diagnostics: { readonly firstLine: (cause: unknown) => string };
};

export function makeBrowserHistoryRecordAction(
  history: Effect.Success<typeof makeComputerUseHistory>,
  run: (effect: ReturnType<typeof recordBrowserAction>) => Promise<void>,
) {
  return <A>(
    tab: Tab,
    action: string,
    execute: () => Promise<A>,
    details?: { url?: string; typedText?: string },
  ): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, 50);
    const url = details?.url ?? tab.page.url();
    const record = (outcome: {
      verdict: "sent" | "refused" | "unknown_outcome";
      refusalCode?: string;
    }) =>
      run(
        recordBrowserAction(history, {
          threadId: tab.threadId,
          url: action === "back" || action === "forward" ? tab.page.url() : url,
          action,
          ...outcome,
          ...(details?.typedText === undefined ? {} : { typedText: details.typedText }),
        }),
      );
    return execute().then(
      async (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        await record({ verdict: "sent" });
        return result;
      },
      async (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = tab.diagnostics.firstLine(cause);
        await record(browserFailure(cause));
        throw cause;
      },
    );
  };
}
