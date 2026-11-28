// Seam (lane F): replaces v1 apps/web/src/components/chat/V2ItemInspector.tsx @916b5cc. v1's inspector fetches the full item (tool output, diffs, images) from the environment. In GOAT 2 that is Part 2
// (the host fetches details lazily by engine locator). Until then the expanded row shows what the log line itself
// carries: a command's input and inline output, a tool's input and inline output. fileChangeDiffTarget is copied verbatim.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import { memo } from "react";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, RunId, ThreadId } from "@goat/contracts";
import { turnItemDetailRevision } from "@goat/client-runtime/work-log/item-detail";
import type { DiffPanelSourceItem, OpenTurnDiff } from "../../diffPanelStore.ts";
import type { ExpandedImagePreview } from "./ExpandedImagePreview.tsx";
import { useInitialOutputReady, type TurnItemSource } from "~/components/chat/timelineRowContext";

const bodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

export function fileChangeDiffTarget(projectedItem: OrchestrationV2ProjectedTurnItem): {
  readonly runId: RunId;
  readonly filePath: string | undefined;
  readonly sourceItem: DiffPanelSourceItem | undefined;
} | null {
  const item = projectedItem.item;
  if (item.type !== "file_change" || item.runId === null) return null;
  return {
    runId: item.runId,
    filePath: item.changes !== undefined && item.changes.length > 1 ? undefined : item.fileName,
    sourceItem:
      item.patchOmitted === true
        ? {
            threadId: projectedItem.sourceThreadId,
            itemId: projectedItem.sourceItemId,
            revision: turnItemDetailRevision(item),
          }
        : undefined,
  };
}

function inlineParts(item: OrchestrationV2ProjectedTurnItem["item"]): { input?: string; output?: string } {
  switch (item.type) {
    case "command_execution":
      return { input: item.input, ...(item.output !== undefined ? { output: item.output } : {}) };
    case "dynamic_tool":
      return {
        input: JSON.stringify(item.input, null, 2),
        ...(item.output !== undefined ? { output: typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2) } : {}),
      };
    default:
      return {};
  }
}

export function FetchedToolOutput(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly source?: TurnItemSource | undefined;
}) {
  useInitialOutputReady(false, props.onInitialOutputReady);
  const { output } = inlineParts(props.projectedItem.item);
  return output ? <pre className={bodyClassName}>{output}</pre> : null;
}

export const V2ItemInspector = memo(function V2ItemInspector(props: {
  readonly onInitialOutputReady?: (() => void) | undefined;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff?: OpenTurnDiff | undefined;
  readonly onRollbackCheckpoint?: (input: { readonly checkpointId: string; readonly scopeId: string }) => void;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  readonly hideFileChangeSummary?: boolean;
  readonly source?: TurnItemSource | undefined;
}) {
  useInitialOutputReady(false, props.onInitialOutputReady);
  const item = props.projectedItem.item;
  const { input, output } = inlineParts(item);
  if (input === undefined && output === undefined) return null;
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {input !== undefined ? <pre className={bodyClassName}>{input}</pre> : null}
      {output !== undefined ? <pre className={bodyClassName}>{output}</pre> : null}
    </div>
  );
});
