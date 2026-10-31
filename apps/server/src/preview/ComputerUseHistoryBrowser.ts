import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toOperationError } from "./ServerBrowserPage.ts";
import type { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";

type History = Effect.Success<typeof makeComputerUseHistory>;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const recordBrowserAction = Effect.fn("ComputerUseHistory.recordBrowserAction")(function* (
  history: History,
  input: {
    readonly threadId: string;
    readonly url: string;
    readonly action: string;
    readonly verdict: "sent" | "refused" | "unknown_outcome";
    readonly refusalCode?: string;
    readonly typedText?: string;
    readonly keepTypedText?: boolean;
    readonly normalField?: boolean;
    readonly secretProtected?: boolean;
  },
) {
  const host = hostOf(input.url);
  yield* history.record({
    threadId: input.threadId,
    target: { kind: "tab", host },
    method: input.action,
    verdict: input.verdict,
    ...(input.refusalCode === undefined ? {} : { refusalCode: input.refusalCode }),
    ...(input.typedText === undefined
      ? {}
      : {
          typed: {
            length: input.typedText.length,
            ...(input.keepTypedText === true &&
            input.normalField === true &&
            input.secretProtected === false
              ? { value: input.typedText }
              : {}),
            keep: input.keepTypedText === true && input.secretProtected === false,
            field: input.normalField === true ? "normal" : "unknown",
          },
        }),
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
