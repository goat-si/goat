import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  DEFAULT_SCREEN_RUN_LIMITS,
  OrchestratorMcpFailure,
  ScreenRunError,
  ScreenRunLimits,
  ScreenRunResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { INPUT_TITLE, INPUT_TITLE_MAX } from "../../../cua/ScreenCellRow.ts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScreenRunService from "../../../screenCode/ScreenRunService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const limitKeys = Object.keys(DEFAULT_SCREEN_RUN_LIMITS) as ReadonlyArray<keyof ScreenRunLimits>;
const ScreenRunToolLimits = Schema.Struct({
  sourceBytes: Schema.optionalKey(Schema.Number),
  cellWallMs: Schema.optionalKey(Schema.Number),
  turnWasmBytes: Schema.optionalKey(Schema.Number),
  heapBytes: Schema.optionalKey(Schema.Number),
  stackBytes: Schema.optionalKey(Schema.Number),
  callsPerCell: Schema.optionalKey(Schema.Number),
  pendingCalls: Schema.optionalKey(Schema.Number),
  argBytes: Schema.optionalKey(Schema.Number),
  returnBytes: Schema.optionalKey(Schema.Number),
  consoleBytes: Schema.optionalKey(Schema.Number),
  treeBytes: Schema.optionalKey(Schema.Number),
  imageBytes: Schema.optionalKey(Schema.Number),
  journalEntries: Schema.optionalKey(Schema.Number),
  activeChildren: Schema.optionalKey(Schema.Number),
}).check(
  Schema.makeFilter((limits) =>
    Object.keys(limits).every(
      (key) =>
        limitKeys.includes(key as keyof ScreenRunLimits) &&
        Number.isSafeInteger(limits[key as keyof ScreenRunLimits]) &&
        (limits[key as keyof ScreenRunLimits] ?? 0) > 0 &&
        (limits[key as keyof ScreenRunLimits] ?? 0) <=
          DEFAULT_SCREEN_RUN_LIMITS[key as keyof ScreenRunLimits],
    ),
  ),
);

export const ScreenRunToolInput = Schema.Struct({
  code: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(INPUT_TITLE_MAX),
      Schema.isPattern(INPUT_TITLE),
    ).annotate({
      description:
        "One line saying what the cell does; it titles the timeline row. Never typed text or secrets.",
    }),
  ),
  reset: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(ScreenRunToolLimits),
});

const isInput = Schema.is(ScreenRunToolInput);
const fields = new Set(["code", "title", "reset", "limits"]);
export function validScreenRunPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const raw = payload as Record<string, unknown>;
  if (!Object.keys(raw).every((key) => fields.has(key))) return false;
  if (raw.limits !== undefined) {
    if (typeof raw.limits !== "object" || raw.limits === null || Array.isArray(raw.limits))
      return false;
    if (!Object.keys(raw.limits).every((key) => limitKeys.includes(key as keyof ScreenRunLimits)))
      return false;
  }
  return isInput(payload);
}

const entry = agentSurfaceRegistry["surface.screen_run"];
export const ScreenRunTool = Tool.make(entry.name, {
  description: entry.description,
  parameters: ScreenRunToolInput,
  success: ScreenRunResult,
  failure: Schema.Union([ScreenRunError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ScreenRunService.ScreenRunService,
  ],
}).annotateMerge(agentSurfaceAnnotations(entry));

export const ScreenToolkit = Toolkit.make(ScreenRunTool);
