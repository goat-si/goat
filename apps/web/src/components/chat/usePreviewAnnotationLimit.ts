import {
  COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
  type PreviewAnnotationPayload,
} from "@goat/contracts";
import { msg, useMessages } from "gt-react";
import { toastManager } from "../ui/toast";

export function usePreviewAnnotationLimit() {
  const m = useMessages();
  return (
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
    direct?: PreviewAnnotationPayload,
  ) => {
    if (
      ![...annotations, ...(direct ? [direct] : [])].some(
        (annotation) =>
          annotation.comment.trim().length > COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
      )
    )
      return false;
    toastManager.add({
      type: "error",
      title: m(msg("Annotation comments must be 8,000 characters or fewer.")),
    });
    return true;
  };
}
