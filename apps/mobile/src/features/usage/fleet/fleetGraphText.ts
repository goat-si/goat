import { COMPACT_GRAPH_NODES } from "@goat/client-runtime/state/fleet-layout";

import { DEFAULT_BASE_FONT_SIZE, normalizeBaseFontSize } from "../../../lib/appearancePreferences";

/** The system text scale labels follow, at most. */
const LABEL_MAX_SYSTEM_SCALE = 1.2;

/**
 * Machine label type, already scaled by GOAT's text size and the system scale (capped). Render it
 * with font scaling off: Android scales lineHeight past maxFontSizeMultiplier, so letting the
 * platform scale it would break the box this size is checked against.
 */
export function fleetGraphLabelStyle(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}) {
  const scale =
    (normalizeBaseFontSize(input.baseFontSize) / DEFAULT_BASE_FONT_SIZE) *
    Math.min(input.fontScale, LABEL_MAX_SYSTEM_SCALE);
  return {
    fontSize: Math.round(12 * scale * 10) / 10,
    lineHeight: Math.round(16 * scale * 10) / 10,
  };
}

/**
 * Whether the graph can show readable machine names: their line must fit the label box the layout
 * keeps clear. Otherwise, and always at accessibility system sizes, the list carries them.
 */
export function showsFleetGraph(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}): boolean {
  return (
    input.fontScale < 1.5 &&
    fleetGraphLabelStyle(input).lineHeight <= COMPACT_GRAPH_NODES.labelHeight
  );
}
