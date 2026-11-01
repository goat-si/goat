import { useAtomValue } from "@effect/atom-react";
import { fileBasename, isWindowsAbsolutePath } from "@goat/shared/path";
import { useState, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { useRightPanelStore } from "~/rightPanelStore";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { type CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import {
  getProjectFilePickerMatches,
  isProjectFilePickerPathQuery,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
  projectFilePickerWorkspacePath,
  resolveProjectFilePickerPath,
  type ProjectFilePickerMatch,
} from "./ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
}

function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly indices: ReadonlyArray<number>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of props.indices) {
    if (start < index) parts.push(props.value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-foreground" key={index}>
        {props.value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));

  return <span className="text-muted-foreground">{parts}</span>;
}

function getEmptyStateMessage(query: string, error: string | null, isPending: boolean): string {
  if (error) return error;
  const isSearching = query.trim().length > 0;
  if (isPending) return isSearching ? "Searching workspace entries…" : "Indexing workspace files…";
  return isSearching ? "No matching files or folders." : "No files found.";
}

function EmptyProjectFilePicker() {
  return (
    <CommandPaletteContent
      aria-label="File picker"
      escapeLabel="Back"
      footerActionLabel="Open file"
      inputProps={{ disabled: true, placeholder: "Search files…" }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        Open a project to search its files.
      </div>
    </CommandPaletteContent>
  );
}

interface PickerResultsProps extends ProjectFilePickerProps {
  readonly platform: string;
  readonly target: ActiveProjectTarget;
  readonly query: string;
  readonly highlightedItemValue: string | null;
}

function FilePickerResults(
  props: PickerResultsProps & {
    readonly matches: ReadonlyArray<ProjectFilePickerMatch>;
    readonly matchedQuery: string;
    readonly emptyStateMessage: string;
    readonly direct?: boolean;
    readonly line?: number;
  },
) {
  const { target } = props;
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasMatchedQuery = /\S/.test(props.matchedQuery);
  const items: CommandPaletteActionItem[] = props.matches.map((match) => ({
    kind: "action",
    value: `${match.kind}:${match.path}`,
    searchTerms: [match.name, match.path],
    title: (
      <>
        {props.direct ? `Open ${match.kind === "directory" ? "folder" : "file"}: ` : null}
        <HighlightedFuzzyText
          active={hasMatchedQuery}
          value={match.name}
          indices={match.nameMatchIndices}
        />
      </>
    ),
    description: (
      <HighlightedFuzzyText
        active={hasMatchedQuery}
        value={`${match.path}${props.line ? `:${props.line}` : ""}`}
        indices={match.pathMatchIndices}
      />
    ),
    icon: <PierreEntryIcon pathValue={match.path} kind={match.kind} theme={resolvedTheme} />,
    run: async () => {
      const path = projectFilePickerWorkspacePath(match.path, target.cwd, props.platform);
      useRightPanelStore
        .getState()
        .openFile(target.threadRef, path, match.kind === "file" ? props.line : undefined);
    },
  }));

  return (
    <CommandPaletteResults
      groups={
        items.length > 0 ? [{ value: "project-files", label: target.projectName, items }] : []
      }
      highlightedItemValue={props.highlightedItemValue}
      isActionsOnly={false}
      keybindings={keybindings}
      onExecuteItem={(item) => {
        if (item.kind !== "action") return;
        props.setOpen(false);
        void item.run();
      }}
      emptyStateMessage={props.emptyStateMessage}
    />
  );
}

function SearchFilePickerResults(props: PickerResultsProps) {
  const result = useProjectFilePickerQuery(
    props.target.environmentId,
    props.target.cwd,
    props.query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    { includeDirectories: true },
  );
  const matches = getProjectFilePickerMatches(result.entries, result.matchedQuery);
  return (
    <FilePickerResults
      {...props}
      matches={matches}
      matchedQuery={result.matchedQuery}
      emptyStateMessage={getEmptyStateMessage(props.query, result.error, result.isPending)}
    />
  );
}

function DirectFilePickerResults(props: PickerResultsProps & { readonly platform: string }) {
  const { environmentId } = props.target;
  const fileAccess = useFilesystemReadAccess(environmentId);
  const homeRelative = props.query.trim().startsWith("~");
  const home = useEnvironmentQuery(
    fileAccess.canReadFiles && homeRelative
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: "~/" } })
      : null,
  );
  const path = resolveProjectFilePickerPath(
    props.query,
    props.platform,
    home.data?.parentPath ?? null,
  );
  const metadata = useEnvironmentQuery(
    fileAccess.canReadFiles && path !== null
      ? projectEnvironment.fileMetadata({ environmentId, input: { path: path.path } })
      : null,
  );
  const entry = metadata.error === null ? metadata.data : null;
  const kind = entry?.kind;
  const read = useEnvironmentQuery(
    fileAccess.canReadFiles &&
      path !== null &&
      !path.directoryOnly &&
      !metadata.isPending &&
      metadata.error === null &&
      kind === "file"
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: props.target.cwd, relativePath: path.path },
        })
      : null,
  );
  // A binary result also proves the host opened and read the file; media uses
  // its own preview rather than the text returned by this query.
  const binary =
    read.failure !== null &&
    "_tag" in read.failure &&
    read.failure._tag === "ProjectReadFileError" &&
    read.failure.failure === "binary_file";
  const isPending = fileAccess.isPending || home.isPending || metadata.isPending || read.isPending;
  const error =
    fileAccess.error ??
    (!fileAccess.canReadFiles && !fileAccess.isPending
      ? "This connection cannot read host files."
      : null) ??
    home.error ??
    metadata.error ??
    (binary ? null : read.error);
  const canOpen =
    error === null &&
    !isPending &&
    path !== null &&
    (kind === "file" || kind === "directory") &&
    (kind === "directory" || read.data !== null || binary) &&
    (!path.directoryOnly || kind === "directory");
  return (
    <FilePickerResults
      {...props}
      direct
      {...(path?.line && kind === "file" ? { line: path.line } : {})}
      matches={
        canOpen
          ? [
              {
                kind,
                path: path.path,
                name: fileBasename(path.path),
                nameMatchIndices: [],
                pathMatchIndices: [],
              },
            ]
          : []
      }
      matchedQuery=""
      emptyStateMessage={
        error ??
        (isPending
          ? "Checking path…"
          : path?.directoryOnly && kind === "file"
            ? "The path is a file, not a folder."
            : kind === "other"
              ? "This path is not a regular file or folder."
              : "Path not found or permission denied.")
      }
    />
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.target.environmentId));
  const platform =
    config?.environment.platform.os ??
    (isWindowsAbsolutePath(props.target.cwd) ? "windows" : "unknown");
  const resultsProps = { ...props, query, highlightedItemValue, platform };

  return (
    <CommandPaletteContent
      aria-label="File picker"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Open"
      inputProps={{ placeholder: "Search files and folders or enter a path…" }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-file-picker"
      value={query}
    >
      {isProjectFilePickerPathQuery(query, platform) ? (
        <DirectFilePickerResults {...resultsProps} platform={platform} />
      ) : (
        <SearchFilePickerResults {...resultsProps} />
      )}
    </CommandPaletteContent>
  );
}

export function ProjectFilePicker(props: ProjectFilePickerProps) {
  const target = useActiveProjectTarget();

  if (!target) {
    return <EmptyProjectFilePicker />;
  }

  return <OpenProjectFilePicker setOpen={props.setOpen} target={target} />;
}
