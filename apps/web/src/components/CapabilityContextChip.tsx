import type { TurnCapability } from "@goat/contracts";
import { GlobeIcon, MonitorIcon } from "~/components/solar";

import { ContextChipShell } from "./contextChipParts";

const TOOLTIP: Record<TurnCapability, string> = {
  "computer-use": "Computer use for this turn",
  browser: "Built-in browser for this turn",
};

/** The `@computer` / `@browser` chip, in the composer and in sent messages alike. */
export function CapabilityContextChip(props: {
  capability: TurnCapability;
  label: string;
  copyMarkdown?: string;
}) {
  const Icon = props.capability === "computer-use" ? MonitorIcon : GlobeIcon;
  return (
    <ContextChipShell
      kind="capability"
      icon={<Icon aria-hidden="true" />}
      label={props.label}
      aria-label={`${props.label}, ${TOOLTIP[props.capability]}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={TOOLTIP[props.capability]}
    />
  );
}
