/**
 * Records a finished screen cell's timeline row under its cell id, from what the cell actually
 * did, before its result reaches the provider; ingestion finds it through the row's cell id.
 *
 * @module ScreenCellRowRecord
 */
import type { ScreenEffectReceipt, ScreenRunError, ScreenRunResult } from "@goat/contracts";
import * as Exit from "effect/Exit";

import type { makeCallApps } from "../cua/ComputerUseCallApps.ts";
import { screenCellSummary, screenCellTitle, type ScreenCellEnd } from "../cua/ScreenCellRow.ts";
import type { ScreenHostBridge } from "./ScreenHostBridge.ts";

/** How a cell ended, by the code that ended it (before an effect made it unknown_outcome). */
export const screenCellEndOf = (code: string): ScreenCellEnd =>
  code === "wall_limit" || code === "deadline"
    ? "deadline"
    : code === "stopped"
      ? "stopped"
      : code === "unknown_outcome"
        ? "unknown"
        : code === "resource_exhausted" || code.endsWith("_limit")
          ? "limit"
          : "failed";

const endOfStatus = (status: ScreenRunResult["status"]): ScreenCellEnd =>
  status === "resource_exhausted" ? "limit" : status;

/** What a failed cell ended by and every receipt it made, which its error reports only in part. */
export interface ScreenCellFailure {
  readonly code: string;
  readonly receipts: readonly ScreenEffectReceipt[];
}

export function recordScreenCellRow(input: {
  readonly callApps: ReturnType<typeof makeCallApps>;
  readonly bridge: ScreenHostBridge;
  readonly cell: { readonly runId: string; readonly turnId: string; readonly cellId: string };
  readonly threadId: string;
  readonly source: string;
  readonly wallMs: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exit: Exit.Exit<ScreenRunResult, ScreenRunError>;
  readonly failure: ScreenCellFailure | undefined;
}) {
  const { callApps, bridge, cell } = input;
  const facts = bridge.takeCellFacts(cell.runId, cell.turnId, cell.cellId);
  callApps.screenCell(input.threadId, input.source, facts.targets);
  const subjects = callApps.takeCellSubjects(cell, facts.targets);
  const outcome = Exit.isSuccess(input.exit)
    ? {
        end: endOfStatus(input.exit.value.status),
        receipts: input.exit.value.journal.map((entry) => entry.receipt),
      }
    : input.failure === undefined
      ? undefined
      : { end: screenCellEndOf(input.failure.code), receipts: input.failure.receipts };
  if (outcome === undefined) return;
  const row = {
    ...outcome,
    keys: facts.keys,
    subjects,
    subjectCount: subjects.length,
    wallMs: input.wallMs,
    durationMs: input.endedAt - input.startedAt,
  };
  const title = screenCellTitle(row);
  callApps.screenRow(
    cell.cellId,
    {
      threadId: input.threadId,
      ...(title === undefined ? {} : { title }),
      summary: screenCellSummary(row),
    },
    input.endedAt,
  );
}
