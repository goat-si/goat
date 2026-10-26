import { memo, type MouseEventHandler, type PointerEventHandler } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  MinimizeIcon as Minimize2Icon,
  PlayIcon,
  SquareIcon,
} from "~/components/solar";
import { CornerUpRight, ListPlus } from "~/components/solar/nodes";
import { MorphIcon } from "~/components/MorphIcon";
import { useClientSettings } from "~/hooks/useSettings";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "@goat/client-runtime/state/composer-dispatch";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canResume?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  compactBeforeSendTokens?: number | null;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
}

const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const messageActionPillClassName =
  "relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-composer-send font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11";

/**
 * Round primary actions (send, stop) stay within the footer's 28px control row, visually no
 * taller than the model and reasoning labels beside them, like Codex. Coarse pointers keep a
 * 44px hit area through a transparent overlay, the same way ComposerControl does, so the
 * visual size stays small on touch screens.
 */
export const composerRoundActionClassName =
  "relative flex size-6 shrink-0 items-center justify-center rounded-full pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  canResume = false,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
  compactBeforeSendTokens = null,
  keepFullHistory = false,
  onToggleKeepFullHistory,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const redesign = useClientSettings((s) => s.redesignEnabled);
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;

  const renderStopGenerationButton = () => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              composerRoundActionClassName,
              "cursor-pointer bg-composer-stop text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none",
            )}
            {...pointerFocusProps}
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label="Stop generation"
          />
        }
      >
        <SquareIcon className="size-3 fill-current" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {canInterrupt ? renderStopGenerationButton() : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <button
          type="submit"
          className={cn(messageActionPillClassName, compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt && (promptHasText || !canResume)) {
    if (promptHasText) {
      return (
        <button
          type="submit"
          className={cn(messageActionPillClassName, compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={cn(messageActionPillClassName, "rounded-r-none px-4")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  messageActionPillClassName,
                  "rounded-l-none border-l border-message-action-foreground/20 px-2",
                )}
                aria-label="Implementation actions"
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
                disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable}
              onClick={() => {
                if (canOperateThread) onImplementPlanInNewThread();
              }}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (canInterrupt && !hasSendableContent && !isEditingQueuedMessage) {
    return renderStopGenerationButton();
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : compactsBeforeSend
        ? "Compact and send"
        : isQueuing
          ? "Queue message"
          : isRunning
            ? "Steer message"
            : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isConnecting
        ? "Connecting"
        : isPreparingWorktree
          ? "Preparing worktree"
          : isSendBusy
            ? isEditingQueuedMessage
              ? "Updating queued message"
              : "Submitting message"
            : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, Ctrl/⌘-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        composerRoundActionClassName,
        "isolate shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none disabled:hover:scale-100",
        "bg-composer-send text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action",
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isConnecting ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {isConnecting || isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-3 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-3" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon className="size-3" icon={isQueuing ? ListPlus : CornerUpRight} />
      ) : (
        <ArrowUpIcon className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  if (compactTokens === null) return submit;

  return (
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={
                redesign
                  ? "relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:text-muted-foreground"
                  : cn(
                      "relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs tabular-nums pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:h-8 [&_svg]:pointer-events-none [&_svg]:size-3.5",
                      keepFullHistory
                        ? "border-border text-muted-foreground hover:text-foreground"
                        : "border-warning/40 text-warning hover:bg-warning/8",
                    )
              }
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={`Compact ${compactTokens} tokens of history before sending`}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          {/* The new design keeps the token count in the tooltip so the permission label keeps its room. */}
          {redesign ? (
            keepFullHistory ? (
              "Keep full"
            ) : (
              "Compact next"
            )
          ) : (
            <>
              {keepFullHistory ? "Full" : "Compact"}
              <span>{compactTokens}</span>
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? `Next send keeps all ${compactTokens} tokens.`
              : `Next send compacts ${compactTokens} tokens first.`}
          </div>
          <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
        </TooltipPopup>
      </Tooltip>
      {submit}
    </div>
  );
});
