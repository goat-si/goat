import type { TurnCapability } from "@goat/contracts";
import { GlobeIcon, MonitorIcon } from "~/components/solar";

import { ContextChipShell } from "./contextChipParts";

const TOOLTIP: Record<TurnCapability, string> = {
  "computer-use": "Computer use for this turn",
  browser: "Built-in browser for this turn",
};

/**
 * The `@computer` / `@browser` chip, in the composer and in sent messages alike. An `@Finder`
 * app chip is a computer use chip whose label is the app's name.
 */
export function CapabilityContextChip(props: {
  capability: TurnCapability;
  label: string;
  /** Set for an app chip. */
  app?: boolean;
  copyMarkdown?: string;
}) {
  const Icon = props.capability === "computer-use" ? MonitorIcon : GlobeIcon;
  const tooltip = props.app
    ? `Computer use with ${props.label} for this turn`
    : TOOLTIP[props.capability];
  return (
    <ContextChipShell
      kind="capability"
      icon={<Icon aria-hidden="true" />}
      label={props.label}
      aria-label={`${props.label}, ${tooltip}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={tooltip}
    />
  );
}
