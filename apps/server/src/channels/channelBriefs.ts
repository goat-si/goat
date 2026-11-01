// @effect-diagnostics-next-line nodeBuiltinImport:off -- notes revisions are content hashes.
import * as NodeCrypto from "node:crypto";
import type { ChannelTaskBrief } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ChannelLedger from "./ChannelLedger.ts";
import { commitTransition } from "./channelTaskWrites.ts";

/** Freeze once per generation and return the snapshot subsequent launch writes must use. */
export const freezeChannelBrief = Effect.fn("channel.freezeBrief")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  owner: string,
  deliveredText: string,
  context: ChannelTaskBrief["context"] = {},
) {
  const previous = yield* ledger.latestTaskBrief(stored.task.taskId);
  if (previous?.generation === stored.task.generation) return { stored, brief: previous };
  const target = stored.task.target;
  if (target === undefined) {
    return yield* new ChannelLedger.ChannelLedgerError({
      reason: "version_conflict",
      detail: "Cannot freeze a brief without a dispatch target.",
    });
  }
  const brief: ChannelTaskBrief = {
    version: (previous?.version ?? 0) + 1,
    generation: stored.task.generation,
    intent: (stored.task.instruction.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "")
      .trim()
      .slice(0, 500),
    instruction: stored.task.instruction,
    deliveredText,
    scopeIn: null,
    scopeOut: null,
    criteria: null,
    verification: null,
    context: { ...context, notesRevision: context.notesRevision ?? null },
    target: {
      environmentId: target.environmentId,
      ...(target.remote === undefined ? {} : { hostId: target.remote.host }),
      provider: target.modelSelection.instanceId,
      model: target.modelSelection.model,
    },
    frozenAt: DateTime.formatIso(yield* DateTime.now),
  };
  const task = yield* commitTransition(
    ledger,
    stored,
    { type: "task.brief.frozen", payload: { brief } },
    { owner },
  );
  if (task === undefined) {
    return yield* new ChannelLedger.ChannelLedgerError({
      reason: "version_conflict",
      detail: "The task changed before its brief was frozen.",
    });
  }
  return { stored: { ...stored, task }, brief };
});

/** Read exact file bytes; a missing file is absent, while other read failures stop launch. */
export const channelNotesRevision = Effect.fn("channel.notesRevision")(function* (
  notesPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(notesPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new ChannelLedger.ChannelLedgerError({
                reason: "persistence",
                detail: "Cannot read channel worker notes.",
                cause,
              }),
            ),
    }),
  );
  return bytes === null ? null : NodeCrypto.createHash("sha256").update(bytes).digest("hex");
});
