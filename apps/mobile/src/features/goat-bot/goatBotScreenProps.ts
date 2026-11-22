import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { BotProfile, ChannelTaskId } from "@goat/contracts";
import type { ReactNode } from "react";
import type { MobileBotApprovalSlot } from "./MobileBotApprovals";
import type { MobileRestoreMember } from "./MobileDeletedBotBanner";
import type { GoatBotVisitSnapshot } from "./useGoatBotVisitSnapshot";

export type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;

export interface GoatBotScreenProps {
  readonly visible: boolean;
  /** False while the app is in the background, where GOAT Bot's steps are not read. */
  readonly foreground?: boolean;
  /** Focused and the app active: what the screen shows has been seen. */
  readonly seen?: boolean;
  readonly taskId?: ChannelTaskId;
  readonly attentionRequest?: string | undefined;
  /** The title the screen that opened this task carried, for a task the list no longer holds. */
  readonly taskTitle?: string | undefined;
  /** A member bot whose conversation this is; the main bot's when absent. */
  readonly member?: BotProfile | null;
  /** Where the person had read the main chat up to when this visit began. */
  readonly readSnapshot?: GoatBotVisitSnapshot | null;
  /** The main bot's profile, which names its chat; absent before the server keeps profiles. */
  readonly main?: BotProfile | null;
  readonly templateRetry?: ReactNode;
  /** Restores a deleted member, or why not now; absent when this person may not manage bots. */
  readonly onRestoreMember?: MobileRestoreMember | undefined;
  readonly onSelectThread?: (thread: ThreadSelection) => void;
  readonly approvalCards?: MobileBotApprovalSlot;
  /** Floating tabs cover the bottom of the screen; the composer rests above them. */
  readonly floatingTabs?: { readonly bottomSafeArea: number };
}
