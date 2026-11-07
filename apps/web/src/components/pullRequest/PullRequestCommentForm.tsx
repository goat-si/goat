import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@goat/contracts";
import { SendIcon } from "~/components/solar";
import { useState, type RefObject } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  PullRequestMarkdownTextarea,
  pullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";
import { pullRequestReviewKey } from "./pullRequestReviewStore";
import { useInlineActionConfirm } from "./useInlineActionConfirm";
import { CommentSpeechControls, useCommentSpeech } from "../../speech/useCommentSpeech";

export function PullRequestCommentForm({
  environmentId,
  reference,
  detail,
  actionPending,
  textareaRef,
  onCommentAction,
  onCommented,
  onClose,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  actionPending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState<"comment" | "close" | "reopen" | null>(null);
  const speech = useCommentSpeech({
    environmentId,
    textareaRef,
    text: body,
    onTextChange: setBody,
    disabled: submitting !== null || actionPending,
  });
  const postComment = useAtomCommand(pullRequestEnvironment.comment, {
    reportFailure: false,
  });
  const inlineConfirm = useInlineActionConfirm(pullRequestReviewKey(reference));
  const followUpAction =
    detail.state === "open" &&
    detail.capabilities.actions.includes("close") &&
    detail.viewerPermissions.actions.includes("close")
      ? ("close" as const)
      : detail.state === "closed" &&
          detail.capabilities.actions.includes("reopen") &&
          detail.viewerPermissions.actions.includes("reopen")
        ? ("reopen" as const)
        : null;

  const submit = async (action: "comment" | "close" | "reopen") => {
    const trimmed = body.trim();
    if (
      trimmed.length === 0 ||
      submitting !== null ||
      actionPending ||
      speech.voice.blocksSubmission()
    )
      return;
    setSubmitting(action);
    if (action !== "comment") {
      const result = await onCommentAction(trimmed, action);
      if (result.commentPosted) {
        setBody("");
        onClose();
      }
      setSubmitting(null);
      return;
    }
    const result = await postComment({
      environmentId,
      input: {
        ...reference,
        body: trimmed,
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(null);
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
    setSubmitting(null);
    onClose();
    onCommented();
  };

  return (
    <div className="space-y-2">
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
        // Lock while posting because success clears the draft.
        disabled={submitting !== null || actionPending}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label={`Comment on this ${sourceControlClients.get(detail.provider).changeRequest.singular}`}
        onValueChange={setBody}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit("comment");
          }
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <CommentSpeechControls speech={speech} />
        {followUpAction === null ? null : (
          <Button
            size="xs"
            variant={followUpAction === "close" ? "destructive-outline" : "outline"}
            disabled={
              body.trim().length === 0 ||
              submitting !== null ||
              actionPending ||
              speech.voice.blocksSubmission()
            }
            {...(followUpAction === "close"
              ? inlineConfirm.props("close", () => void submit("close"))
              : { onClick: () => void submit("reopen") })}
          >
            {followUpAction === "close" ? (
              <PullRequestGlyph.closed className="size-3.5" />
            ) : (
              <PullRequestGlyph.reopen className="size-3.5" />
            )}
            {followUpAction === "close" ? (
              // The longest label holds the width, so the confirming click lands on the button.
              <span className="inline-grid">
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  Close with comment
                </span>
                <span className="col-start-1 row-start-1">
                  {submitting === "close"
                    ? "Closing..."
                    : inlineConfirm.isArmed("close")
                      ? "Confirm close?"
                      : "Close with comment"}
                </span>
              </span>
            ) : submitting === "reopen" ? (
              "Reopening..."
            ) : (
              "Reopen with comment"
            )}
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={
            body.trim().length === 0 ||
            submitting !== null ||
            actionPending ||
            speech.voice.blocksSubmission()
          }
          onClick={() => void submit("comment")}
        >
          <SendIcon className="size-3.5" />
          {submitting === "comment" ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}
