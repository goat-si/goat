import type { AgentCursorOwner, AgentCursorState } from "@goat/contracts";
import type {
  PreviewStreamPointer,
  PreviewStreamViewport,
} from "@goat/client-runtime/preview/server-browser-stream";

import { agentCursorOwnerFields } from "./agentCursorOwner";
import { viewportToBox } from "./letterbox";

export interface AgentCursorPlacement {
  readonly phase: PreviewStreamPointer["phase"];
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly owner?: AgentCursorOwner;
  readonly cursorPhase?: AgentCursorState;
}

/** The canvas a stream paints: its pixel size and the size it is shown at. */
export interface PaintedCanvas {
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** Where an agent pointer lands on the canvas, or null before a viewport and a canvas size. */
export function placeAgentCursor(
  pointer: PreviewStreamPointer,
  canvas: PaintedCanvas | null,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!canvas || !viewport || canvas.width < 1 || canvas.height < 1) return null;
  const box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const { x: left, y: top } = viewportToBox(pointer, box, canvas, viewport);
  return {
    phase: pointer.phase,
    sequence: pointer.sequence,
    left,
    top,
    ...agentCursorOwnerFields(pointer.cursor),
  };
}

/**
 * The drawn cursor after the canvas, its box or the viewport changed: it moves to where its pointer
 * lands now and keeps its phase and owner. An unmoved cursor, or one with no box, keeps its object.
 */
export function replaceAgentCursor(
  current: AgentCursorPlacement | null,
  pointer: PreviewStreamPointer,
  canvas: PaintedCanvas,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!current || canvas.clientWidth < 1 || canvas.clientHeight < 1) return current;
  const placed = placeAgentCursor(pointer, canvas, viewport);
  if (!placed || (placed.left === current.left && placed.top === current.top)) return current;
  return { ...current, left: placed.left, top: placed.top };
}
