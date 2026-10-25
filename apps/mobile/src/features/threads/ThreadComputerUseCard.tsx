import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import {
  COMPUTER_USE_RUN_STATUS_LABELS,
  computerUseObservedTarget,
  computerUseResult,
  type ComputerUseRun,
  type ComputerUseRunStatus,
} from "@goat/client-runtime/work-log/computer-use";
import {
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
} from "@goat/client-runtime/work-log/item-detail";
import { View } from "react-native";

import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { AppText as Text } from "../../components/ui/AppText";
import { useTurnItemDetail } from "../../state/queries";
import { ThreadMarkdownImage } from "./ThreadMarkdownImage";

const STATUS_CLASS = {
  running: "text-foreground-muted",
  succeeded: "text-adaptive-emerald-600-400",
  unsettled: "text-warning-foreground",
  failed: "text-adaptive-rose-600-400",
  denied: "text-warning-foreground",
  stopped: "text-foreground-subtle",
} as const satisfies Record<ComputerUseRunStatus, string>;

/**
 * A computer-use call's status, target, and the screenshots its result gave the model. Expanded,
 * the row's own gallery shows the screenshots, so this card shows them only while collapsed.
 */
export function ThreadComputerUseCard(props: {
  readonly run: ComputerUseRun;
  readonly status: ComputerUseRunStatus | null;
  readonly row: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly showScreenshots: boolean;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const detail = useTurnItemDetail(
    props.showScreenshots && turnItemNeedsDetailFetch(props.row.item)
      ? { environmentId: props.environmentId, row: props.row }
      : null,
  );
  const fetched = detail.data?.item;
  const item = fetched?.type === props.row.item.type ? fetched : props.row.item;
  const images = props.showScreenshots ? turnItemOutputImages(item) : [];
  const target =
    (item.type === "dynamic_tool" ? computerUseObservedTarget(item.output) : null) ??
    props.run.target;
  const { status, note } = computerUseResult(
    props.run,
    props.status,
    item.type === "dynamic_tool" ? item.output : undefined,
  );
  if (status === null && target === null && images.length === 0) return null;
  return (
    <View className="ml-7 gap-1.5 pb-1.5">
      <View className="flex-row items-center gap-2">
        {status === null ? null : (
          <Text className={`font-goat-medium text-xs ${STATUS_CLASS[status]}`}>
            {COMPUTER_USE_RUN_STATUS_LABELS[status]}
          </Text>
        )}
        {target === null ? null : (
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {target}
          </Text>
        )}
      </View>
      {note === null ? null : <Text className="text-xs text-foreground-muted">{note}</Text>}
      {images.length === 0 ? null : (
        <FilePreviewGallery
          value={images.map((resource) => ({
            kind: "image",
            environmentId: props.environmentId,
            resource,
          }))}
        >
          {images.map((resource) => (
            <ThreadMarkdownImage
              key={resource.index}
              environmentId={props.environmentId}
              resource={resource}
              alt="Screenshot the agent saw"
              onPressPreview={props.onPressPreview}
            />
          ))}
        </FilePreviewGallery>
      )}
    </View>
  );
}
