/**
 * Puts back notes GOAT refused to forget while other work held a notes grant, once that work has
 * ended, and tells the person in the conversation of the work that removed them.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a cause key needs a short stable hash.
import * as NodeCrypto from "node:crypto";

import type { ChannelTaskId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ChannelLedger from "./ChannelLedger.ts";
import { ChannelBotNoteWriter } from "./channelBotNoteWriter.ts";
import { noteKeptNotice } from "./channelCopy.ts";
import { deliveryIdFor } from "./channelIds.ts";

export const makeKeptNotes = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const writer = yield* ChannelBotNoteWriter;

  /** One pass; answers how many notices it queued. */
  return Effect.fn("ChannelBotNotesKept.keep")(function* () {
    // A task stopped by a person ends before its run does, and the run can still edit the notes.
    const runsOpen = new Set(
      (yield* ledger.listOpenWorkerRuns()).map((run) => run.taskId as string),
    );
    const kept = yield* writer.keepRefused(runsOpen);
    if (kept.length === 0) return 0;
    const now = DateTime.formatIso(yield* DateTime.now);
    let queued = 0;
    for (const { note, holders } of kept) {
      const hash = NodeCrypto.createHash("sha256").update(note).digest("hex").slice(0, 16);
      for (const holder of holders) {
        const stored = yield* ledger.getTask(holder as ChannelTaskId);
        if (stored === undefined) continue;
        const causeKey = "notes-kept:" + holder + ":" + hash;
        const deliveryId = deliveryIdFor(causeKey);
        yield* ledger.enqueueDeliveries(
          [
            {
              deliveryId,
              causeKey,
              taskId: stored.task.taskId,
              message: {
                deliveryId,
                destination: stored.task.originAddress,
                kind: "receipt",
                text: noteKeptNotice(note),
                taskId: stored.task.taskId,
              },
            },
          ],
          now,
        );
        queued += 1;
      }
    }
    return queued;
  });
});
