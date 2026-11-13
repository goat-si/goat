import { stackedThreadToast, toastManager } from "../ui/toast";

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
