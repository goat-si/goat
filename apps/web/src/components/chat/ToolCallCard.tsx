import { commandDisplayText } from "@goat/client-runtime/work-log/command-label";
import { Check, Copy } from "~/components/solar/nodes";
import { type ReactNode, useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShellCommandBlock } from "./ShellCommandBlock";

export function ToolCallCard(props: {
  readonly title: string;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-tool-call-card className="overflow-hidden rounded-lg border border-border bg-accent">
      <div className="flex h-7 items-center ps-2.5 pe-1 font-sans text-xs text-muted-foreground select-none">
        <span className="min-w-0 truncate">{props.title}</span>
      </div>
      <div className="px-2.5 pb-2">{props.children}</div>
      {props.footer ? (
        <div className="flex justify-end px-2.5 pb-1.5 font-sans text-xs text-muted-foreground select-none">
          {props.footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Wraps one part of a tool call with its own copy button, shown on hover or keyboard focus.
 * The wrapped content reserves the button's lane with `pe-7` so the button never covers text.
 */
export function CopyRegion(props: {
  readonly text: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "text" });
  const text = props.text;
  return (
    <div className="group/copy relative">
      {props.children}
      {text.trim() ? (
        // Touch screens have no hover, so the button stays visible there.
        <span className="absolute top-0 right-0 opacity-0 transition-opacity group-hover/copy:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={props.label}
                  onClick={() => copyToClipboard(text, undefined)}
                />
              }
            >
              <MorphIcon className="size-3" icon={isCopied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{isCopied ? "Copied" : props.label}</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}

export function ShellCommandLine({ command }: { readonly command: string }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((value) => !value);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={(event) => {
        // A click that ends a text selection inside the command must not toggle it.
        const selection = window.getSelection();
        if (
          selection !== null &&
          !selection.isCollapsed &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return;
        }
        toggle();
      }}
      onKeyDown={(event) => {
        if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
        event.preventDefault();
        toggle();
      }}
      className={cn(
        "cursor-pointer rounded-sm pe-7 focus-visible:outline-2 focus-visible:outline-ring",
        !expanded && "line-clamp-2",
      )}
    >
      <span aria-hidden className="me-[1ch] text-muted-foreground">
        $
      </span>
      <ShellCommandBlock command={commandDisplayText(command)} />
    </div>
  );
}
