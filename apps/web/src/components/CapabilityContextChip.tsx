import { appChipIconResource } from "@goat/client-runtime/composerCapabilityItems";
import type { EnvironmentId, TurnCapability } from "@goat/contracts";
import { GlobeIcon, MonitorIcon } from "~/components/solar";

import { NativeAppIcon } from "./chat/TimelineToolActivityIcon";
import { ContextChipShell } from "./contextChipParts";

const TOOLTIP: Record<TurnCapability, string> = {
  "computer-use": "Computer use for this turn",
  browser: "Built-in browser for this turn",
};

/**
 * The `@computer` / `@browser` chip, in the composer and in sent messages alike. An `@Finder`
 * app chip is a computer use chip whose label is the app's name and whose icon is the app's own,
 * as the chip's host draws it; it keeps the computer use icon until then and when there is none.
 */
export function CapabilityContextChip(props: {
  capability: TurnCapability;
  label: string;
  /** Set for an app chip. */
  app?: boolean;
  contextId?: string;
  environmentId?: EnvironmentId | null;
  copyMarkdown?: string;
}) {
  const Icon = props.capability === "computer-use" ? MonitorIcon : GlobeIcon;
  const icon = <Icon aria-hidden="true" />;
  const appIcon =
    props.app && props.contextId !== undefined
      ? appChipIconResource(props.contextId, props.label)
      : null;
  const tooltip = props.app
    ? `Computer use with ${props.label} for this turn`
    : TOOLTIP[props.capability];
  return (
    <ContextChipShell
      kind="capability"
      icon={
        appIcon && props.environmentId ? (
          <NativeAppIcon
            environmentId={props.environmentId}
            app={appIcon.app}
            // Sent messages make every img inline (.chat-markdown img), which would drop it below the chip's line.
            className="size-[1.17em] shrink-0 self-center [&_img]:align-top"
            fallback={icon}
            bare
          />
        ) : (
          icon
        )
      }
      label={props.label}
      aria-label={`${props.label}, ${tooltip}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={tooltip}
    />
  );
}
