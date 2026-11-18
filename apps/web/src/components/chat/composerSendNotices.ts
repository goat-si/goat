import { stackedThreadToast, toastManager } from "../ui/toast";

export function notifyTerminalDuringQuestion() {
  toastManager.add({
    type: "info",
    title: "Terminal output can't be added to a question answer.",
    description: "Answer or dismiss the question first, then add it to chat.",
  });
}

export function notifyDirectAnnotationAttached(hasAnnotation: boolean) {
  if (!hasAnnotation) return;
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "Annotation attached to draft",
      description: "Sending is unavailable right now. Finish the current action, then send.",
    }),
  );
}
