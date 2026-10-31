// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Browser action timing uses wall-clock timestamps.
import type { PreviewAutomationActionEvent } from "@goat/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { pushBounded } from "./boundedBuffer.ts";
import { browserFailure, recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";
import type { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { scheduleHistory } from "../cua/ComputerUseHistoryBackground.ts";
import { historyStamp, type HistoryStamp } from "../cua/ComputerUseHistoryStamp.ts";

type Tab = {
  readonly threadId: string;
  readonly page: { readonly url: () => string };
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly diagnostics: { readonly firstLine: (cause: unknown) => string };
};

export const makeBrowserHistoryFork = Effect.fn("ComputerUseHistory.makeBrowserFork")(function* () {
  return Effect.runForkWith(yield* Effect.context<never>());
});

export function makeBrowserHistoryRecordAction(
  history: Effect.Success<typeof makeComputerUseHistory>,
  fork: (effect: Effect.Effect<void>) => unknown,
  serverScope: Scope.Scope,
  now: () => number = () => Date.now(),
) {
  return <A>(
    tab: Tab,
    action: string,
    execute: () => Promise<A>,
    details?: {
      url?: string;
      typedText?: string;
      targetLabel?: string;
      finishRetention?: () => Promise<boolean>;
    },
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
    const schedule = (
      outcome: {
        verdict: "sent" | "refused" | "unknown_outcome";
        refusalCode?: string;
      },
      stamp: HistoryStamp,
    ) => {
      const snapshot = (() => {
        try {
          return {
            threadId: tab.threadId,
            stamp,
            url: action === "back" || action === "forward" ? tab.page.url() : url,
            action,
            ...(details?.targetLabel === undefined ? {} : { targetLabel: details.targetLabel }),
            ...outcome,
            ...(details?.typedText === undefined ? {} : { typedText: details.typedText }),
            finishRetention: details?.finishRetention,
          };
        } catch (cause) {
          fork(Effect.logWarning("Computer use history snapshot failed", { cause }));
          return undefined;
        }
      })();
      if (snapshot === undefined) return;
      const { finishRetention, ...entry } = snapshot;
      const record = Effect.fn("ComputerUseHistory.recordBrowserOutcome")(function* () {
        const evidence =
          finishRetention === undefined
            ? false
            : yield* Effect.tryPromise(finishRetention).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Computer use history evidence failed", { cause }).pipe(
                    Effect.as(false),
                  ),
                ),
              );
        const keep = entry.verdict === "sent" && evidence;
        yield* recordBrowserAction(history, {
          ...entry,
          ...(keep ? { keepTypedText: true, normalField: true, secretProtected: false } : {}),
        });
      });
      fork(
        scheduleHistory(browserHistoryPrefix(snapshot.threadId) + event.id, record(), serverScope),
      );
    };
    return execute().then(
      (result) => {
        event.status = "succeeded";
        const completed = now();
        event.completedAt = new Date(completed).toISOString();
        schedule({ verdict: "sent" }, historyStamp(completed));
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        const completed = now();
        event.completedAt = new Date(completed).toISOString();
        event.error = tab.diagnostics.firstLine(cause);
        schedule(browserFailure(cause), historyStamp(completed));
        throw cause;
      },
    );
  };
}

export const browserHistoryPrefix = (threadId: string) => `browser:${JSON.stringify(threadId)}:`;
