import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  getItem(id: string): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// Ref attachment and post-render flushes keep requests pending until the viewer holds the file.
export function createCodeViewFileReveal() {
  let viewer: FileRevealHandle | null = null;
  let pending: string | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending, align: "start" });
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    request(fileKey: string) {
      pending = fileKey;
      flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal(scope: string) {
  const [current, setCurrent] = useState(() => ({ scope, reveal: createCodeViewFileReveal() }));
  if (current.scope === scope) return current.reveal;
  const next = { scope, reveal: createCodeViewFileReveal() };
  setCurrent(next);
  return next.reveal;
}
