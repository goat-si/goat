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
    details?: { url?: string; typedText?: string; finishRetention?: () => Promise<boolean> },
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
    const record = async (outcome: {
      verdict: "sent" | "refused" | "unknown_outcome";
      refusalCode?: string;
    }) => {
      const evidence = await (details?.finishRetention?.() ?? Promise.resolve(false));
      const keep = outcome.verdict === "sent" && evidence;
      await run(
        recordBrowserAction(history, {
          threadId: tab.threadId,
          url: action === "back" || action === "forward" ? tab.page.url() : url,
          action,
          ...outcome,
          ...(details?.typedText === undefined ? {} : { typedText: details.typedText }),
          ...(keep ? { keepTypedText: true, normalField: true, secretProtected: false } : {}),
        }),
      );
    };
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
