import type { ResponseContextRecord } from "@goat/contracts";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * Each mounted composer's handle, keyed by its form element. A chat column holds one timeline and
 * one composer, so Reply finds the composer beside the clicked message even when the same thread
 * is open twice. Holds handles only; a composer that unmounts takes its entry with it.
 */
const handles = new WeakMap<Element, ComposerHandleRef>();

/** The composer form's ref callback: fills `formRef` and lets Reply in its column find it. */
export function useComposerReplyTarget(
  formRef: { current: HTMLFormElement | null },
  handleRef: ComposerHandleRef,
) {
  return useStableCallback((form: HTMLFormElement | null) => {
    formRef.current = form;
    if (!form) return;
    handles.set(form, handleRef);
    return () => {
      handles.delete(form);
      formRef.current = null;
    };
  });
}

export type ReplyOutcome = "replying" | "refused" | "no-composer";

/** Hands a reply to the composer in the same chat column as `element`. */
export function replyFromTimeline(element: Element, response: ResponseContextRecord): ReplyOutcome {
  const form = element
    .closest("[data-chat-column]")
    ?.querySelector('[data-chat-composer-form="true"]');
  const handle = form ? handles.get(form)?.current : null;
  if (!handle) return "no-composer";
  return handle.replyToResponse(response) ? "replying" : "refused";
}
