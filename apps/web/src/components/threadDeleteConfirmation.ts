import type { useGT } from "gt-react";

export function threadDeleteConfirmation(gt: ReturnType<typeof useGT>, title: string) {
  return [
    gt('Delete thread "{title}"?', { title }),
    gt("This permanently clears conversation history for this thread."),
  ].join("\n");
}

export function threadsDeleteConfirmation(gt: ReturnType<typeof useGT>, count: number) {
  return [
    gt("Delete {count, plural, one {# thread} other {# threads}}?", { count }),
    gt("This permanently clears conversation history for these threads."),
  ].join("\n");
}
