import { XIcon as X } from "~/components/solar";
import type { MouseEvent, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface PanelTabCloseButtonProps {
  children: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  tooltip?: string;
  /** `lg` fits the 32px right panel tabs; `default` fits the compact terminal drawer tabs. */
  size?: "default" | "lg";
  /** -1 when the surrounding tab already handles keyboard close. */
  tabIndex?: number;
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
  size = "default",
  tabIndex,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      type="button"
      className={cn(
        "cursor-pointer group/close relative flex shrink-0 items-center justify-center hover:bg-muted",
        size === "lg" ? "size-5 rounded-md [&_svg]:size-3.5" : "size-4 rounded-sm",
      )}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={onClick}
    >
      <span
        className={cn(
          "relative flex items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden",
          size === "lg" ? "size-3.5" : "size-3",
        )}
      >
        {children}
      </span>
      <X
        className={cn(
          "hidden group-hover/tab:block group-focus-visible/close:block",
          size === "lg" ? "size-3.5" : "size-3",
        )}
      />
    </button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
