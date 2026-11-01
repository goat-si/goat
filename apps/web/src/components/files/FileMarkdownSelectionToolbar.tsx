import { COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS } from "@goat/contracts";
import { resolvePathLinkTarget } from "@goat/shared/fileLinks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  composerTargetKey,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { captureRenderedTextSelection } from "~/lib/assistantTextSelection";
import { randomUUID } from "~/lib/utils";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { QuoteIcon } from "~/components/solar";
import { Button } from "~/components/ui/button";

type SelectionToolbarProps = {
  viewport: HTMLElement | null;
  cwd: string;
  relativePath: string;
  composerDraftTarget?: ComposerThreadTarget | undefined;
};

export function FileMarkdownSelectionToolbar(props: SelectionToolbarProps) {
  if (!props.composerDraftTarget) return null;
  return (
    <SelectionToolbar
      key={JSON.stringify([
        props.cwd,
        props.relativePath,
        composerTargetKey(props.composerDraftTarget),
      ])}
      {...props}
      composerDraftTarget={props.composerDraftTarget}
    />
  );
}

function SelectionToolbar({
  viewport,
  cwd,
  relativePath,
  composerDraftTarget,
}: SelectionToolbarProps & { composerDraftTarget: ComposerThreadTarget }) {
  const [selection, setSelection] = useState<{
    text: string;
    start: number;
    end: number;
    position: SelectionActionPoint;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    const view = toolbar.ownerDocument.defaultView!;
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, view.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, view.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const document = viewport.ownerDocument;
    const view = document.defaultView!;
    const clear = () => setSelection(null);
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onDismiss: clear,
      onSelection: (pointer) => {
        const captured = captureRenderedTextSelection(viewport, view.getSelection());
        if (!captured) return clear();
        const rect = captured.range.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        if (rect.width === 0 || rect.bottom < bounds.top || rect.top > bounds.bottom)
          return clear();
        setSelection({
          text: captured.selector.text,
          start: captured.selector.start,
          end: captured.selector.end,
          position: resolveSelectionActionPosition({
            bounds,
            selectionRect: rect,
            pointer,
            viewport: { width: view.innerWidth, height: view.innerHeight },
          }),
        });
      },
    });
    // A selectionchange left over from a previous file/thread is not a new gesture.
    actions.cancel();
    actionsRef.current = actions;
    // Only scrolling that moves this file's viewport invalidates the action's
    // position; a chat transcript following a streaming turn must not.
    const dismissOnAncestorScroll = (event: Event) => {
      // Drop stale coordinates and pending reopen timers, but keep an
      // autoscrolling drag alive so its release still shows the action.
      if (event.target instanceof Node && event.target.contains(viewport)) actions.scrolled();
    };
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.disabled ||
        toolbar.contains(event.target as Node)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    // The file's ScrollArea viewport is an ancestor of this Markdown wrapper.
    document.addEventListener("scroll", dismissOnAncestorScroll, true);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      document.removeEventListener("scroll", dismissOnAncestorScroll, true);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [viewport]);

  if (!selection || !viewport) return null;
  const tooLong = selection.text.length > COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS;
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      style={{ left: selection.position.x, top: selection.position.y }}
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to quote" : "Add selection to chat"}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          actionsRef.current?.cancel();
          setSelection(null);
        }
      }}
      onClick={() => {
        useComposerDraftStore.getState().addReviewComment(composerDraftTarget, {
          id: randomUUID(),
          sectionId: "rendered-markdown-selection",
          sectionTitle: "Rendered Markdown quote",
          filePath: resolvePathLinkTarget(relativePath, cwd),
          // These are rendered-text offsets, never source lines or editor annotations.
          startIndex: selection.start,
          endIndex: selection.end,
          rangeLabel: "Selected text",
          text: "Quoted rendered Markdown (no source line numbers).",
          diff: selection.text,
          fenceLanguage: "text",
        });
        viewport.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
        actionsRef.current?.cancel();
        setSelection(null);
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Add to chat"}
    </Button>,
    viewport.ownerDocument.body,
  );
}
