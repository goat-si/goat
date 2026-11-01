import { useState, type ReactNode } from "react";
import {
  ArrowRightLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "~/components/solar";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { PdfZoom } from "./pdfLayout";

export function PdfIconButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function PdfPageInput(props: {
  page: number;
  count: number;
  navigate: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.page));
  const commit = () => {
    const value = Number(draft);
    if (Number.isInteger(value) && value >= 1 && value <= props.count) props.navigate(value);
    else setDraft(String(props.page));
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
      className="w-14"
    >
      <Input
        aria-label="PDF page number"
        size="compact"
        type="number"
        min={1}
        max={props.count}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </form>
  );
}

export function PdfToolbar(props: {
  page: number;
  count: number;
  scale: number;
  navigate: (page: number) => void;
  zoom: (zoom: PdfZoom) => void;
  find: () => void;
  reload: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="PDF controls"
      data-glass-layer
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-2 py-1 text-xs"
    >
      <PdfIconButton
        label="Previous PDF page"
        disabled={props.page <= 1}
        onClick={() => props.navigate(props.page - 1)}
      >
        <ChevronLeftIcon />
      </PdfIconButton>
      <PdfPageInput
        key={props.page}
        page={props.page}
        count={props.count}
        navigate={props.navigate}
      />
      <span aria-label={`${props.count} pages`} className="shrink-0 tabular-nums">
        / {props.count}
      </span>
      <PdfIconButton
        label="Next PDF page"
        disabled={props.page >= props.count}
        onClick={() => props.navigate(props.page + 1)}
      >
        <ChevronRightIcon />
      </PdfIconButton>
      <PdfIconButton
        label="Zoom out"
        disabled={props.scale <= 0.1}
        onClick={() => props.zoom(props.scale / 1.25)}
      >
        <MinusIcon />
      </PdfIconButton>
      <span className="w-10 shrink-0 text-center tabular-nums">
        {Math.round(props.scale * 100)}%
      </span>
      <PdfIconButton
        label="Zoom in"
        disabled={props.scale >= 5}
        onClick={() => props.zoom(props.scale * 1.25)}
      >
        <PlusIcon />
      </PdfIconButton>
      <PdfIconButton label="Fit width" onClick={() => props.zoom("fit-width")}>
        <ArrowRightLeftIcon />
      </PdfIconButton>
      <PdfIconButton label="Fit page" onClick={() => props.zoom("fit-page")}>
        <MaximizeIcon />
      </PdfIconButton>
      <PdfIconButton label="Find" onClick={props.find}>
        <SearchIcon />
      </PdfIconButton>
      <PdfIconButton label="Reload PDF" onClick={props.reload}>
        <RefreshCwIcon />
      </PdfIconButton>
    </div>
  );
}
