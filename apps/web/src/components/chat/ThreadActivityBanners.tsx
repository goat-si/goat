import { deriveProviderExtensionStatuses } from "@goat/client-runtime/state/thread-execution";
import type { ThreadStructure } from "@goat/client-runtime/state/shell";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  HELD_TURN_STOP_NOTE,
  presentPendingBackgroundWork,
  presentProviderGoal,
  type RunStartHoldPresentation,
  type RunStopPresentation,
} from "@goat/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@goat/client-runtime/state/threads";
import {
  ClockIcon,
  GitBranchIcon,
  MessageCircleIcon,
  ShieldQuestionIcon,
  TargetIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "~/components/solar";
import { Fragment, useState } from "react";
import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";

export function withPiExtensionStatus(
  items: ComposerBannerStackItem[],
  projection: ThreadStructure | null,
): ComposerBannerStackItem[] {
  const statuses = deriveProviderExtensionStatuses(projection);
  if (statuses.length === 0) return items;
  return [
    ...items,
    {
      id: "pi-extension-status",
      variant: "default",
      icon: <span>▸</span>,
      title: <output>{`Pi · ${statuses.map((status) => status.text).join(" · ")}`}</output>,
    },
  ];
}

/** Subagents waiting on the user, unless the parent is itself waiting on them. */
export function childInputBannerItem(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  readonly parentAwaitingUser: boolean;
  readonly onOpenThread: (threadId: ThreadId, options: { environmentId: EnvironmentId }) => void;
}): ComposerBannerStackItem | null {
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    variant: "info",
    priority: "activity",
    icon: first.hasPendingApprovals ? <ShieldQuestionIcon /> : <MessageCircleIcon />,
    title: childThreadInputsTitle(childThreadInputs),
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton
            tone="muted"
            onClick={() => onOpenThread(child.id, { environmentId: child.environmentId })}
          >
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => onOpenThread(first.id, { environmentId: first.environmentId })}
      >
        {first.hasPendingApprovals ? "Open approval" : "Open question"}
      </Button>
    ),
  };
}

export function goalBannerItem(input: {
  readonly threadId: ThreadId;
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isWorking: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
}): ComposerBannerStackItem {
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking);
  return {
    id: `goal:${input.threadId}`,
    variant: "default",
    priority: "activity",
    icon: <TargetIcon />,
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}
          >
            Resume
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
        >
          Clear
        </Button>
      </>
    ),
  };
}

/** A sent message that waits for another Codex turn to end, so it does not read as stuck. */
export function startHoldBannerItem(input: {
  readonly threadId: ThreadId;
  readonly hold: RunStartHoldPresentation;
  /** Offered for a turn no run owns; a turn an earlier run started stops with its own run. */
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
}): ComposerBannerStackItem {
  return {
    id: `start-hold:${input.threadId}`,
    variant: "info",
    priority: "activity",
    icon: <ClockIcon />,
    title: input.hold.title,
    description: input.hold.description,
    actions:
      input.canStop && input.hold.reason === "unowned_turn" && input.hold.nativeTurnId ? (
        <StopHeldTurnAction
          key={input.hold.nativeTurnId}
          stopping={input.stopping}
          onStop={input.onStop}
        />
      ) : undefined,
  };
}

function StopHeldTurnAction({ stopping, onStop }: { stopping: boolean; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" disabled={stopping} onClick={() => setOpen(true)}>
        {stopping ? "Stopping..." : "Stop that turn"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop that turn?</AlertDialogTitle>
            <AlertDialogDescription>{HELD_TURN_STOP_NOTE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={stopping}
              onClick={() => {
                setOpen(false);
                onStop();
              }}
            >
              Stop turn
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** A Stop the provider has not finished; Force stop once it stops answering. */
export function runStopBannerItem(input: {
  readonly threadId: ThreadId;
  readonly stop: RunStopPresentation;
  readonly canForceStop: boolean;
  readonly forceStopping: boolean;
  readonly onForceStop: () => void;
}): ComposerBannerStackItem {
  const unresponsive = input.stop.state === "unresponsive";
  return {
    id: `run-stop:${input.threadId}`,
    variant: unresponsive ? "warning" : "default",
    priority: unresponsive ? "urgent" : "activity",
    icon: unresponsive ? <TriangleAlertIcon /> : <SquareIcon />,
    title: unresponsive ? "Agent not responding to Stop" : "Stopping",
    description: !unresponsive
      ? undefined
      : input.stop.cloud
        ? "The cloud provider has not confirmed the stop yet."
        : "It may be short on memory. Force stop kills its processes.",
    actions:
      unresponsive && input.canForceStop && !input.stop.cloud ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={input.forceStopping}
          onClick={input.onForceStop}
        >
          {input.forceStopping ? "Force stopping..." : "Force stop"}
        </Button>
      ) : undefined,
  };
}

export function backgroundWorkBannerItem(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const { onOpenThread } = input;
  const presentation = presentPendingBackgroundWork(input.tasks);
  if (presentation === null) return null;
  return {
    id: `background-work:${input.threadId}`,
    variant: "default",
    priority: "activity",
    icon: (
      <span
        className={cn(
          "size-1.5 rounded-full bg-foreground",
          presentation.waiting && "motion-safe:animate-status-pulse",
        )}
        aria-hidden="true"
      />
    ),
    title: presentation.title,
    description:
      presentation.items.length === 1 && presentation.items[0]?.childThreadId === undefined
        ? undefined
        : presentation.items.map((item, index) => {
            const childThreadId = item.childThreadId;
            const separator = index < presentation.items.length - 1 ? "," : null;
            return (
              <Fragment key={item.taskId}>
                {index > 0 ? " " : null}
                {childThreadId === undefined ? (
                  <>
                    {item.label}
                    {separator}
                  </>
                ) : (
                  <span className="whitespace-nowrap">
                    <InlineButton
                      tone="muted"
                      aria-label={`${presentation.items.length === 1 ? "Show" : "Open"} subagent ${item.label}`}
                      onClick={() => onOpenThread(childThreadId)}
                    >
                      {presentation.items.length === 1 ? "Show" : item.label}
                    </InlineButton>
                    {separator}
                  </span>
                )}
              </Fragment>
            );
          }),
    actions: (
      <>
        <BackgroundWorkDetails tasks={input.tasks} />
        <Button
          size="xs"
          variant="ghost"
          disabled={input.stopDisabled}
          onClick={() => void input.onStop()}
        >
          {input.stopping ? "Stopping..." : "Stop"}
        </Button>
      </>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(input: {
  readonly mismatchKey: string;
  readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
  readonly restoreDisabled: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { mismatch } = input;
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-normal text-muted-foreground">Branch changed from</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 truncate font-medium text-foreground">
                {mismatch.threadBranch}
              </code>
            }
          />
          <TooltipPopup side="top">
            This thread last ran on {mismatch.threadBranch}. Sending will continue on{" "}
            {mismatch.currentBranch}.
          </TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? "Restoring..." : "Restore branch"}
      </Button>
    ),
    dismissLabel: "Dismiss branch change notice",
    onDismiss: input.onDismiss,
  };
}
