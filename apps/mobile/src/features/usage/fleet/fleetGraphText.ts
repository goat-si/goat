import { COMPACT_GRAPH_NODES } from "@goat/client-runtime/state/fleet-layout";

import { DEFAULT_BASE_FONT_SIZE, normalizeBaseFontSize } from "../../../lib/appearancePreferences";

/** The system text scale labels follow, at most. */
export const FLEET_GRAPH_LABEL_MAX_SCALE = 1.2;

/** Machine label type at GOAT's text size; the system scale applies on top, up to its cap. */
export function fleetGraphLabelStyle(baseFontSize: number) {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  return { fontSize: Math.round(12 * scale), lineHeight: Math.round(16 * scale) };
}

/**
 * Whether the graph can show readable machine names: their line, at GOAT's text size and the
 * system scale, must fit the label box the layout keeps clear. Otherwise the list carries them.
 */
export function showsFleetGraph(input: {
  readonly baseFontSize: number;
  readonly fontScale: number;
}): boolean {
  if (input.fontScale >= 1.5) return false;
  const { lineHeight } = fleetGraphLabelStyle(input.baseFontSize);
  return (
    lineHeight * Math.min(input.fontScale, FLEET_GRAPH_LABEL_MAX_SCALE) <=
    COMPACT_GRAPH_NODES.labelHeight
  );
}
