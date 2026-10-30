import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import {
  COMPUTER_USE_RUN_STATUS_LABELS,
  computerUseObservedTarget,
  computerUseItemResult,
  computerUseNeedsResultDetail,
  type ComputerUseRun,
  type ComputerUseRunStatus,
} from "@goat/client-runtime/work-log/computer-use";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@goat/client-runtime/work-log/item-detail";

import { useTurnItemDetail } from "../../state/queries";
import { Badge } from "../ui/badge";
import { ComputerUseHistorySection } from "./ComputerUseHistorySection";

const STATUS_VARIANT = {
  running: "info",
  succeeded: "success",
  unsettled: "warning",
  failed: "error",
  denied: "warning",
  stopped: "secondary",
} as const satisfies Record<ComputerUseRunStatus, string>;

/**
 * An expanded computer-use call's status and target. The row's inspector shows the screenshots
 * its result gave the model, so a collapsed row stays one line, like Codex's.
 */
export function ComputerUseRunCard(props: {
  readonly run: ComputerUseRun;
  readonly status: ComputerUseRunStatus | null;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
}) {
  const wireItem = props.projectedItem.item;
  const wireOutput = wireItem.type === "dynamic_tool" ? wireItem.output : undefined;
  const detail = useTurnItemDetail(
    computerUseNeedsResultDetail(props.run, wireOutput) && turnItemNeedsDetailFetch(wireItem)
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
  const target =
    (item.type === "dynamic_tool" ? computerUseObservedTarget(item.output) : null) ??
    props.run.target;
  const { status, note } = computerUseItemResult(
    props.run,
    props.status,
    wireOutput,
    fetched?.type === "dynamic_tool" ? fetched.output : undefined,
  );
  if (status === null && target === null) return null;
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
      <ComputerUseHistorySection
        key={`${props.environmentId}:${props.projectedItem.sourceThreadId}`}
        environmentId={props.environmentId}
        threadId={props.projectedItem.sourceThreadId}
      />
    </div>
  );
}
