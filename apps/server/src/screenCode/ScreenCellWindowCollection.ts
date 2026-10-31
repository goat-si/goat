import * as Effect from "effect/Effect";
import type { ScreenRunError } from "@goat/contracts";
import type { DesktopTargetHost } from "./DesktopTargetHost.ts";
import type { CellWindowsOutcome } from "./DesktopWindows.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";

export const collectCellWindows = (
  host: DesktopTargetHost | undefined,
  context: ScreenHostContext,
  cellDeadlineMillis: number,
  skipEndRead: boolean,
): Effect.Effect<CellWindowsOutcome, ScreenRunError> =>
  host?.finishCell?.(context, { skipEndRead, cellDeadlineMillis }) ?? Effect.succeed({});
