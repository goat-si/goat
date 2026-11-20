import type { ThreadCheckpointSummary } from "@goat/client-runtime/state/thread-checkpoints";
import type { WorkLogLineCounts } from "@goat/client-runtime/work-log/line-counts";
import type {
  ToolGroupSummaryKind,
  WorkLogPresentationEntry,
  WorkLogToolLifecycleStatus,
} from "@goat/client-runtime/work-log/presentation";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunStatus,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type { GoatMcpToolLogo } from "@goat/shared/goatMcpToolPresentation";
import type { HtmlRenderReference } from "@goat/shared/htmlRender";
import type { McpAppReference } from "@goat/shared/mcpApp";

import type { ThreadActivityIcon } from "./threadActivityIcons";
import type { ThinkingRow } from "./threadThinkingRow";

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly attemptId: RunAttemptId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  readonly fetchesDetail: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon: ThreadActivityIcon;
  readonly logo: GoatMcpToolLogo | null;
  readonly toolLike: boolean;
  readonly prominent: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
  readonly lifecycleStatus: WorkLogToolLifecycleStatus;
  readonly workEntry: WorkLogPresentationEntry;
  readonly groupedToolDetail?: boolean;
  readonly live?: boolean;
  /** Lone calls carry the group header's label and id until a second call joins. */
  readonly groupStandIn?: { readonly groupId: string; readonly label: string };
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export interface ThreadFeedMessage {
  readonly context?: import("@goat/contracts").OrchestrationMessageContext | undefined;
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly idleCompaction?: import("@goat/contracts").OrchestrationV2IdleCompaction;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
  readonly checkpointSummary?: ThreadCheckpointSummary;
}

export interface LocalThreadMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ThreadFeedMessage;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activity: ThreadFeedActivity;
    }
  | {
      readonly type: "html-render";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly render: HtmlRenderReference;
    }
  | {
      readonly type: "sent-message";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly text: string;
    }
  | {
      readonly type: "mcp-app";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      /** The thread and item that own the app; a fork's inherited app is its source's. */
      readonly sourceThreadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly revision: string;
      readonly app: McpAppReference;
    };

export type ThreadFeedEntry = ThreadFeedEntryContent & {
  readonly continuesWorkLog?: boolean;
  readonly checkpointSummary?: ThreadCheckpointSummary;
};

type ThreadFeedEntryContent =
  | Extract<RawThreadFeedEntry, { type: "message" | "html-render" | "sent-message" | "mcp-app" }>
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly toolSurface?: WorkLogPresentationEntry["toolSurface"];
      readonly toolIcon?: WorkLogPresentationEntry["toolIcon"];
      readonly summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";
      readonly hasFailure: boolean;
      /** Total lines added and removed, for a settled group of edits that all reported counts. */
      readonly lineCounts?: WorkLogLineCounts;
      readonly live: boolean;
      readonly shimmer: boolean;
      readonly thought?: string;
    }
  | {
      /** Images the agent opened in the tool group above, kept visible while the group is collapsed. */
      readonly type: "viewed-images";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly type: "run-fold";
      readonly deferredWorkItemIds?: ReadonlyArray<string>;
      readonly workingSince?: string;
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | ThinkingRow;

export interface ThreadFeedLatestRun {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly turnEnded?: boolean;
  readonly providerStartingLabel?: string;
}

export type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;
