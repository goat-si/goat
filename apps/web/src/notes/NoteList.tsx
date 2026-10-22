import type { NoteSummary } from "@goat/contracts";
import { PinIcon, PlusIcon, SearchIcon } from "~/components/solar";
import { useRef, type KeyboardEvent } from "react";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { filterNotes, openablePath, orderNotes } from "./noteState";

const STATUS_LABEL = { doing: "Doing", done: "Done" } as const;

export function NoteList(props: {
  notes: ReadonlyArray<NoteSummary>;
  selectedPath: string | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (path: string, options?: { replace?: boolean }) => void;
  onOpenEditor: () => void;
  onCreate: (() => void) | null;
  createShortcut: string | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const matches = filterNotes(props.notes, props.query);
  const { pinned, rest } = orderNotes(matches);
  const ordered = [...pinned, ...rest];
  const pathToOpen = openablePath(props.notes, props.query);
  const focusRow = (index: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-note-row]");
    const row = rows?.[Math.max(0, Math.min(index, (rows?.length ?? 1) - 1))];
    if (!row) return;
    row.focus();
    const path = row.dataset.noteRow;
    if (path && path !== props.selectedPath) props.onSelect(path, { replace: true });
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      props.onSelect(event.currentTarget.dataset.noteRow!);
      props.onOpenEditor();
    } else if (event.key === "Escape" || (event.key === "ArrowUp" && index === 0)) {
      searchRef.current?.focus();
    }
  };
  const selectedIndex = ordered.findIndex((note) => note.path === props.selectedPath);
  const renderRow = (note: NoteSummary, index: number) => (
    <li key={note.path}>
      <button
        type="button"
        data-note-row={note.path}
        tabIndex={index === Math.max(selectedIndex, 0) ? 0 : -1}
        aria-current={note.path === props.selectedPath ? "page" : undefined}
        onClick={() => props.onSelect(note.path)}
        onKeyDown={(event) => onRowKeyDown(event, index)}
        className="grid w-full gap-0.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {note.pinned && (
            <PinIcon
              aria-label="Pinned"
              className="size-3 shrink-0 self-center text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium [word-break:keep-all]">
            {note.title}
          </span>
          <time
            dateTime={note.updatedAt}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {formatRelativeTimeLabel(note.updatedAt)}
          </time>
        </span>
        {note.preview ? (
          <span className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {note.preview}
          </span>
        ) : null}
        {note.folder || note.status !== "idea" ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {note.folder && <span className="min-w-0 truncate">{note.folder}</span>}
            {note.status !== "idea" && (
              <span
                className={cn(
                  "shrink-0 font-medium",
                  note.status === "done" ? "text-success-foreground" : "text-info-foreground",
                )}
              >
                {STATUS_LABEL[note.status]}
              </span>
            )}
          </span>
        ) : null}
      </button>
    </li>
  );
  return (
    <nav aria-label="Notes" className={cn("flex min-h-0 flex-col", props.className)}>
      <div className="flex items-center gap-2 p-3">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(0);
              } else if (event.key === "Enter" && pathToOpen) {
                props.onSelect(pathToOpen);
              } else if (event.key === "Enter" && ordered[0]) {
                props.onSelect(ordered[0].path);
                props.onOpenEditor();
              } else if (event.key === "Escape" && props.query) {
                event.preventDefault();
                props.onQueryChange("");
              }
            }}
            data-notes-search
          />
        </InputGroup>
        {props.onCreate && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="New note"
                  onClick={props.onCreate}
                />
              }
            >
              <PlusIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              New note
              {props.createShortcut ? <Kbd className="ms-2">{props.createShortcut}</Kbd> : null}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {props.children}
        {pathToOpen && (
          <button
            type="button"
            className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-primary outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => props.onSelect(pathToOpen)}
          >
            Open {pathToOpen}
          </button>
        )}
        {props.notes.length > 0 && ordered.length === 0 && !pathToOpen && (
          <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
            No notes match “{props.query.trim()}”.
          </p>
        )}
        <ul ref={listRef} className="grid gap-px">
          {pinned.length > 0 && rest.length > 0 && (
            <li aria-hidden className="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground">
              Pinned
            </li>
          )}
          {pinned.map((note, index) => renderRow(note, index))}
          {pinned.length > 0 && rest.length > 0 && (
            <li aria-hidden className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
              Notes
            </li>
          )}
          {rest.map((note, index) => renderRow(note, pinned.length + index))}
        </ul>
      </div>
    </nav>
  );
}
