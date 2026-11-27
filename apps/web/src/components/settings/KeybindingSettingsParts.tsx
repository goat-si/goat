import { useGT } from "gt-react";
import type { ReactNode, RefObject } from "react";
import { MinusIcon, SearchIcon, TriangleAlertIcon } from "~/components/solar";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import type { KeybindingRow } from "./KeybindingsSettings.logic";
import { useKeybindingDisplayLabel } from "./useKeybindingDisplayLabel";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { handleKeybindingsSearchEscape } from "./keybindingsSearchEscape";

export function KeybindingsSearchInput({
  query,
  onChange,
  inputRef,
}: {
  query: string;
  onChange: (next: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const gt = useGT();
  const label = gt("Search keybindings");
  return (
    <InputGroup className="min-w-0 basis-full **:[input]:h-9 sm:basis-0 sm:flex-1 sm:**:[input]:h-8">
      <InputGroupAddon>
        <SearchIcon aria-hidden className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => handleKeybindingsSearchEscape(event, query, onChange)}
        placeholder={label}
        aria-label={label}
        size="sm"
      />
    </InputGroup>
  );
}

function WarningTooltipIcon({
  label,
  focusable = true,
  className,
  children,
}: {
  label: string;
  focusable?: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-warning/25",
              className,
            )}
          />
        }
      >
        <TriangleAlertIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

export function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>;
  focusable?: boolean;
}) {
  const gt = useGT();
  if (identifiers.length === 0) return null;
  const label =
    identifiers.length === 1
      ? gt("Unknown condition: {condition}", { condition: identifiers[0] ?? "" })
      : gt("Unknown conditions: {conditions}", { conditions: identifiers.join(", ") });

  return (
    <WarningTooltipIcon label={label} focusable={focusable} className="size-4.5">
      {gt(
        "GOAT does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.",
      )}
    </WarningTooltipIcon>
  );
}

export function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> }) {
  const gt = useGT();
  if (labels.length === 0) return null;
  const commands = labels.slice(0, 3).join(", ");
  const description =
    labels.length > 3
      ? gt("Conflicts with {commands}, and more.", { commands })
      : gt("Conflicts with {commands}.", { commands });

  return (
    <WarningTooltipIcon label={description}>
      {description} {gt("The most recent matching binding wins when both conditions can apply.")}
    </WarningTooltipIcon>
  );
}

export function BrowserKeybindingNotice() {
  const gt = useGT();
  const message = gt(
    "The browser may claim some shortcuts first. The desktop app receives them all.",
  );
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={message}>
            <TriangleAlertIcon className="size-3.5 text-warning" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {message}
      </TooltipPopup>
    </Tooltip>
  );
}

function KeybindingSourceBadge({ source }: { source: KeybindingRow["source"] }) {
  const gt = useGT();
  if (source === "Default") return null;
  return (
    <Badge variant="outline" size="sm">
      {source === "Custom" ? gt("Custom") : gt("Project")}
    </Badge>
  );
}

export function KeybindingRowTitle({ row }: { row: KeybindingRow }) {
  const labelForCommand = useKeybindingDisplayLabel();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex items-center gap-2" />}>
        {labelForCommand(row.command)}
        <KeybindingSourceBadge source={row.source} />
      </TooltipTrigger>
      <TooltipPopup side="top">{row.command}</TooltipPopup>
    </Tooltip>
  );
}

export function WhenExpressionRemoveButton({
  label,
  className,
  onRemove,
}: {
  label: string;
  className?: string | undefined;
  onRemove: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn("size-7", className)}
            aria-label={label}
            onClick={onRemove}
          />
        }
      >
        <MinusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
