import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import {
  COMPUTER_USE_RUN_STATUS_LABELS,
  computerUseObservedTarget,
  computerUseItemResult,
  type ComputerUseRun,
  type ComputerUseRunStatus,
} from "@goat/client-runtime/work-log/computer-use";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
} from "@goat/client-runtime/work-log/item-detail";

import { useTurnItemDetail } from "../../state/queries";
import { Badge } from "../ui/badge";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

const STATUS_VARIANT = {
  running: "info",
  succeeded: "success",
  unsettled: "warning",
  failed: "error",
  denied: "warning",
  stopped: "secondary",
} as const satisfies Record<ComputerUseRunStatus, string>;

const LAZY_IMAGE = { loading: "lazy" } as const;

/**
 * A computer-use call's status, target, and the screenshots its result gave the model. The
 * screenshots load only when asked for, and the timeline mounts only the rows on screen.
 */
export function ComputerUseRunCard(props: {
  readonly run: ComputerUseRun;
  readonly status: ComputerUseRunStatus | null;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly showScreenshots: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const wireItem = props.projectedItem.item;
  const detail = useTurnItemDetail(
    props.showScreenshots && turnItemNeedsDetailFetch(wireItem)
      ? {
          environmentId: props.environmentId,
          threadId: props.projectedItem.sourceThreadId,
          itemId: props.projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const fetched = detail.data?.item;
  const item = fetched?.type === wireItem.type ? fetched : wireItem;
  const images = props.showScreenshots ? turnItemOutputImages(item) : [];
  const target =
    (item.type === "dynamic_tool" ? computerUseObservedTarget(item.output) : null) ??
    props.run.target;
  const { status, note } = computerUseItemResult(
    props.run,
    props.status,
    wireItem.type === "dynamic_tool" ? wireItem.output : undefined,
    fetched?.type === "dynamic_tool" ? fetched.output : undefined,
  );
  if (status === null && target === null && images.length === 0) return null;
  return (
    <div
      className="ms-7 mt-1 mb-1.5 flex min-w-0 flex-col gap-1.5"
      data-computer-use-run={props.run.tool}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {status === null ? null : (
          <Badge variant={STATUS_VARIANT[status]}>{COMPUTER_USE_RUN_STATUS_LABELS[status]}</Badge>
        )}
        {target === null ? null : <span className="min-w-0 truncate">{target}</span>}
      </div>
      {note === null ? null : <p className="text-xs text-muted-foreground">{note}</p>}
      {images.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {images.map((resource) => (
            <ChatMarkdownAssetImage
              key={resource.index}
              environmentId={props.environmentId}
              resource={resource}
              alt="Screenshot the agent saw"
              maxHeightRem={10}
              imageProps={LAZY_IMAGE}
              onImageExpand={props.onImageExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}
