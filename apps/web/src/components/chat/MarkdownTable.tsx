import { CheckIcon, CopyIcon } from "~/components/solar";
import { use, useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";
import { MarkdownTableCopyOnCard } from "./markdownTableCopyOnCard";

type TableTextFormat = Exclude<TableCopyFormat, "png">;

const TABLE_COPY_SERIALIZERS: Record<TableTextFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

// Loaded on first use; the clipboard write still starts inside the click.
const renderTablePng = (table: HTMLTableElement) =>
  import("./tablePng").then((module) => module.renderTablePng(table));

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onCard = use(MarkdownTableCopyOnCard);
  const {
    copyToClipboard,
    copyPngToClipboard,
    isCopied: copied,
  } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? "Copied" : "Copy table";
  // Insecure origins (plain http over a LAN or tailnet) have no async clipboard for images.
  const canCopyPng =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

  const handleCopy = (format: TableTextFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
    );
  };

  const handleCopyPng = () => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyPngToClipboard(() => renderTablePng(table), "png");
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div
        className={
          onCard
            ? "goat-table-card-copy absolute end-2 top-2.5 flex select-none"
            : "mt-0.5 -mx-1 flex items-center justify-end select-none"
        }
      >
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
            <MenuItem onClick={() => handleCopy("html")}>Copy as HTML</MenuItem>
            {canCopyPng ? <MenuItem onClick={handleCopyPng}>Copy as PNG</MenuItem> : null}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
