import { commandDisplayText } from "@goat/client-runtime/work-log/command-label";
import { Check, Copy } from "~/components/solar/nodes";
import { type ReactNode, useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ShellCommandBlock } from "./ShellCommandBlock";

export function ToolCallCard(props: {
  readonly title: string;
  readonly copyText: string | null;
  readonly copyLabel: string;
  readonly status?: ReactNode;
  readonly children: ReactNode;
}) {
  const { copyText } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "command" });
  return (
    <div
      data-tool-call-card
      className="overflow-hidden rounded-lg border border-border bg-muted/25"
    >
      <div className="flex h-7 items-center gap-2 ps-2.5 pe-1 font-sans text-xs text-muted-foreground select-none">
        <span className="min-w-0 flex-1 truncate">{props.title}</span>
        {props.status}
        {copyText ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.copyLabel}
            title={props.copyLabel}
            onClick={() => copyToClipboard(copyText, undefined)}
          >
            <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
          </Button>
        ) : null}
      </div>
      <div className="px-2.5 pb-2">{props.children}</div>
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
        "cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring",
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
