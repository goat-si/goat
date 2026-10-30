import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toOperationError } from "./ServerBrowserPage.ts";
import type { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";

type History = Effect.Success<typeof makeComputerUseHistory>;

export const recordBrowserAction = Effect.fn("ComputerUseHistory.recordBrowserAction")(function* (
  history: History,
  input: {
    readonly threadId: string;
    readonly url: string;
    readonly action: string;
    readonly verdict: "sent" | "refused" | "unknown_outcome";
    readonly refusalCode?: string;
    readonly typedText?: string;
  },
) {
  let host = "";
  try {
    host = new URL(input.url).hostname;
  } catch {
    /* Invalid URLs have no host. */
  }
  yield* history.record({
    threadId: input.threadId,
    target: { kind: "tab", host },
    method: input.action,
    verdict: input.verdict,
    ...(input.refusalCode === undefined ? {} : { refusalCode: input.refusalCode }),
    ...(input.typedText === undefined
      ? {}
      : { typed: { length: input.typedText.length, keep: false, field: "unknown" } }),
  });
});

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
export function browserFailure(cause: unknown) {
  const error = toOperationError(cause);
  const before = isRecord(error.detail) && error.detail.beforeInput === true;
  if (
    before ||
    error.tag === "PreviewAutomationInvalidSelectorError" ||
    error.tag === "PreviewAutomationTargetNotEditableError"
  )
    return { verdict: "refused", refusalCode: error.tag } as const;
  return { verdict: "unknown_outcome" } as const;
}
