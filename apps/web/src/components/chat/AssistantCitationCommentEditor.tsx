import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  type EnvironmentId,
} from "@goat/contracts";
import { useRef, useState, type RefObject } from "react";
import { textDirection } from "~/textDirection";
import {
  CommentSpeechControls,
  CommentSpeechScope,
  type useCommentSpeech,
} from "../../speech/useCommentSpeech";

import { Button } from "../ui/button";

export function AssistantCitationCommentEditor({
  citation,
  environmentId,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
}: {
  citation: AssistantCitation;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  environmentId?: EnvironmentId | null | undefined;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? fallbackRef;
  const updateComment = (value: string) => {
    setComment(value);
    onDraftChange?.(value);
  };
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (commentTooLong) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };

  const renderEditor = (speech: ReturnType<typeof useCommentSpeech> | null) => (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (speech?.voice.blocksSubmission()) {
            speech.voice.cancel();
            return;
          }
          onCancel();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label="Comment on selected text"
        aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        dir={textDirection(comment)}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => {
          updateComment(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !speech?.voice.blocksSubmission() &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              submitAndSend();
            } else {
              submit();
            }
          }
        }}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {speech ? <CommentSpeechControls speech={speech} /> : null}
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={commentTooLong || (speech?.voice.blocksSubmission() ?? false)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
  return environmentId ? (
    <CommentSpeechScope
      environmentId={environmentId}
      textareaRef={textareaRef}
      text={comment}
      onTextChange={updateComment}
    >
      {renderEditor}
    </CommentSpeechScope>
  ) : (
    renderEditor(null)
  );
}
