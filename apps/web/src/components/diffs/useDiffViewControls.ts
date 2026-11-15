import { useStableCallback } from "~/hooks/useStableCallback";
import type { AnnotatableCodeViewHandle } from "./AnnotatableCodeView";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";
import { useCodeViewScrollRestore } from "./useCodeViewScrollRestore";

export function useDiffViewControls(
  revealScope: string,
  scrollScope: string | null,
  settled: boolean,
  loadMore: (() => void) | null,
) {
  const reveal = useCodeViewFileReveal(revealScope);
  const scroll = useCodeViewScrollRestore(scrollScope, settled, loadMore);
  const attach = useStableCallback((handle: AnnotatableCodeViewHandle | null) => {
    scroll.attach(handle);
    reveal.attach(handle);
  });
  const flush = useStableCallback(() => {
    scroll.flush();
    reveal.flush();
  });
  return { reveal, scroll, attach, flush };
}
