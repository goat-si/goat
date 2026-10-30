import type { ComputerUseLeaseCallOutcome } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { makeComputerUseHistory } from "./ComputerUseHistory.ts";

type History = Effect.Success<typeof makeComputerUseHistory>;

export const recordCallOutcome = Effect.fn("ComputerUseHistory.recordCallOutcome")(function* (
  history: History,
  threadId: string,
  report: ComputerUseLeaseCallOutcome,
  keepTypedText: boolean,
) {
  yield* history.record({
    threadId,
    target: {
      kind: "app",
      ...(report.app === undefined ? {} : { id: report.app.id, name: report.app.name }),
    },
    method: report.tool,
    verdict: report.verdict,
    ...(report.targetLabel === undefined ? {} : { targetLabel: report.targetLabel }),
    ...(report.refusalCode === undefined ? {} : { refusalCode: report.refusalCode }),
    ...(report.typed === undefined
      ? {}
      : {
          typed: {
            length: report.typed.length,
            ...(report.typed.text === undefined ? {} : { value: report.typed.text }),
            field: report.typed.fieldKind,
            keep: keepTypedText,
          },
        }),
  });
});
