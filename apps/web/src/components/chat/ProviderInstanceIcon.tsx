import { type CSSProperties, memo, type ReactElement } from "react";

import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
} from "@goat/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@goat/contracts";
import { AntigravityIcon, ClaudeAI, Icon, OpenAI } from "../Icons";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AcpRegistryAgentIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "../settings/AcpRegistryIcon";

const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

const PROVIDER_TEXT_COLOR_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "text-black dark:text-white",
  [ProviderDriverKind.make("claudeAgent")]: "text-[#d97757]",
  [ProviderDriverKind.make("antigravity")]: "text-[#5b87bf]",
};

export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (icon) {
    return {
      className: "text-(--icon-light) dark:text-(--icon-dark)",
      style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
    };
  }
  const className = PROVIDER_TEXT_COLOR_BY_PROVIDER[driverKind];
  return className ? { className } : {};
}

export function resolveProviderInstanceAcpRegistryIconUrl(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly iconUrl?: string | undefined;
}): string | null {
  if (input.driverKind !== "acpRegistry") return null;
  return (
    resolveOfficialAcpRegistryIconUrl(input.iconUrl ?? null) ??
    officialAcpRegistryIconUrlForAgentId(input.agentId?.trim() || null)
  );
}

/**
 * A provider's logo as a bare `<svg>` placed at (x, y), for drawing inside another SVG
 * where HTML cannot go. Null when the provider has no vector logo.
 */
export function renderProviderGlyph(input: {
  readonly driverKind: ProviderDriverKind;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}): ReactElement | null {
  const placement = { x: input.x, y: input.y, width: input.size, height: input.size };
  const packageIcon = providerClients.get(input.driverKind)?.icon;
  if (packageIcon) return <ProviderPackageIcon icon={packageIcon} {...placement} aria-hidden />;
  const Icon = PROVIDER_ICON_BY_PROVIDER[input.driverKind];
  return Icon ? <Icon {...placement} className="text-foreground" aria-hidden /> : null;
}

/** Cloud providers run on a vendor's machines; the name says so even when the mark is shared. */
export function providerInstanceIconLabel(input: {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly holder?: string | null | undefined;
}): string {
  if (providerClients.get(input.driverKind)?.executionLocation !== "cloud")
    return input.displayName;
  const name = /\bcloud\b/i.test(input.displayName)
    ? input.displayName
    : `${input.displayName} (cloud)`;
  return input.holder ? `${name} · ${input.holder}` : name;
}

// A shape, not a color, marks a cloud run: the local provider's mark with a cloud in its corner.
function CloudBadge(props: { readonly surface: string }) {
  return (
    <span
      aria-hidden
      data-provider-cloud-badge=""
      className="pointer-events-none absolute -right-[30%] -bottom-[24%] z-20 flex size-[68%] min-h-2 min-w-2 items-center justify-center rounded-full text-foreground"
      style={{ backgroundColor: props.surface, boxShadow: `0 0 0 1px ${props.surface}` }}
    >
      <svg viewBox="0 0 16 16" className="size-[86%]" fill="currentColor">
        <path d="M4.25 13.5h7.6a3.4 3.4 0 0 0 .42-6.78A4.75 4.75 0 0 0 3.2 7.5a3.01 3.01 0 0 0 1.05 6Z" />
      </svg>
    </span>
  );
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  size?: "default" | "compact";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
  /** Where a cloud run's sign-in lives, named in the tooltip: "Claude Cloud · mini". */
  holder?: string | null | undefined;
  /** A tab stop for the tooltip; only where the icon is not inside a button or link. */
  focusable?: boolean;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const packageIcon = providerClients.get(props.driverKind)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentColor = normalizeProviderAccentColor(props.accentColor);
  const accentStyle = accentColor
    ? ({
        "--provider-accent": accentColor,
        "--provider-accent-foreground": providerAccentForegroundColor(accentColor),
      } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  const iconClassName = cn(props.size === "compact" && "size-3.5", props.iconClassName);
  const isAcpRegistry = props.driverKind === "acpRegistry";
  const isCloud = providerClients.get(props.driverKind)?.executionLocation === "cloud";
  const label = providerInstanceIconLabel(props);
  const acpRegistryIconUrl = resolveProviderInstanceAcpRegistryIconUrl({
    driverKind: props.driverKind,
    agentId: props.acpRegistryAgentId,
    iconUrl: props.acpRegistryIconUrl,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            tabIndex={props.focusable ? 0 : undefined}
            className={cn(
              "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              props.className,
            )}
            style={accentStyle}
            data-provider-accent-color={accentColor}
            data-provider-cloud={isCloud ? "" : undefined}
          />
        }
      >
        {isAcpRegistry ? (
          <AcpRegistryAgentIcon
            className={cn("size-5 rounded-none bg-transparent", iconClassName)}
            fallbackClassName="size-full"
            icon={acpRegistryIconUrl}
          />
        ) : packageIcon ? (
          <ProviderPackageIcon
            icon={packageIcon}
            className={cn("size-5 shrink-0", iconClassName)}
            aria-hidden
          />
        ) : Icon ? (
          <Icon className={cn("size-5 shrink-0", iconClassName)} aria-hidden />
        ) : (
          <span className={cn("text-3xs font-semibold leading-none", iconClassName)}>
            {providerInstanceInitials(props.displayName)}
          </span>
        )}
        {props.statusDotClassName ? (
          <span
            className={cn(
              "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
              props.statusDotClassName,
            )}
            style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
            aria-hidden
          />
        ) : null}
        {props.showBadge ? (
          <span
            className={cn(
              "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
              accentColor
                ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
                : "bg-card text-muted-foreground",
              props.size === "compact" &&
                "right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs",
              // The cloud badge owns the bottom corner.
              isCloud && "top-[-0.1875rem] bottom-auto",
              props.badgeClassName,
            )}
            style={{ borderColor: indicatorBackground }}
            aria-hidden
          >
            {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
          </span>
        ) : null}
        {isCloud ? <CloudBadge surface={indicatorBackground} /> : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
});
