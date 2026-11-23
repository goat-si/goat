import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ActiveAcpTurn } from "./activeTurn.ts";
import type { BackgroundWorkReport } from "@goat/provider-core/server/notification";

export function makeRecordWakeReport(
  activeTurn: Ref.Ref<ActiveAcpTurn | null>,
  wakeReports: Ref.Ref<{
    readonly reports: ReadonlyMap<string, BackgroundWorkReport>;
    readonly offered: ReadonlySet<string>;
  }>,
) {
  return Effect.fnUntraced(function* (key: string, report: BackgroundWorkReport) {
    const context = yield* Ref.get(activeTurn);
    if (context !== null && !context.promptSettled && !context.finalized) return;
    yield* Ref.update(wakeReports, ({ reports, offered }) => ({
      reports: new Map(reports).set(key, report),
      offered,
    }));
  });
}
