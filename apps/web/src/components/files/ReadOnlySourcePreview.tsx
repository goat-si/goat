import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useRef, type ClipboardEvent } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/**
 * Select All spans the file's shadow tree, where the virtualizer mounts only rows near the viewport.
 * Null when this engine cannot read a selection inside a shadow tree.
 */
function selectsEveryMountedRow(root: ShadowRoot): boolean | null {
  const rows = root.querySelectorAll("[data-line]");
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return false;
  const selection = document.getSelection();
  if (typeof selection?.getComposedRanges !== "function") return null;
  try {
    const selected = selection.getComposedRanges({ shadowRoots: [root] })[0];
    if (!selected) return false;
    if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) {
      return false;
    }
    const range = document.createRange();
    range.setStart(selected.startContainer, selected.startOffset);
    range.setEnd(selected.endContainer, selected.endOffset);
    // A dragged selection ends inside rows, so it never holds a row's own boundaries.
    return (
      range.comparePoint(first, 0) === 0 && range.comparePoint(last, last.childNodes.length) === 0
    );
  } catch {
    return null;
  }
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectedAllRef = useRef(false);
  // oxlint-disable-next-line goat/react-effect-budget -- Where a shadow-tree selection cannot be read, remember a Select All pressed after a press in this preview.
  useEffect(() => {
    try {
      // One probe with the dictionary argument: an engine may lack the method or reject the form.
      document.getSelection()?.getComposedRanges({ shadowRoots: [] });
      return;
    } catch {
      // Fall through to remembering Select All.
    }
    let pressedInside = false;
    let held: readonly [Node | null, number, Node | null, number] | null = null;
    const notePress = (event: PointerEvent) => {
      pressedInside = event.target instanceof Node && !!wrapperRef.current?.contains(event.target);
      selectedAllRef.current = false;
    };
    // Only the copy shortcut and bare modifier keys keep a remembered Select All.
    const noteKey = (event: globalThis.KeyboardEvent) => {
      const shortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      const key = event.key.toLowerCase();
      if (shortcut && key === "a") {
        selectedAllRef.current = pressedInside;
        held = null;
      } else if (!(shortcut && key === "c") && !MODIFIER_KEYS.has(event.key)) {
        selectedAllRef.current = false;
      }
    };
    // The first change after Select All is its own; any later one ends it.
    const noteSelection = () => {
      if (!selectedAllRef.current) return;
      const selection = document.getSelection();
      const now = [
        selection?.anchorNode ?? null,
        selection?.anchorOffset ?? 0,
        selection?.focusNode ?? null,
        selection?.focusOffset ?? 0,
      ] as const;
      const previous = held;
      if (previous === null) held = now;
      else if (now.some((part, index) => part !== previous[index])) selectedAllRef.current = false;
    };
    document.addEventListener("pointerdown", notePress, true);
    document.addEventListener("keydown", noteKey, true);
    document.addEventListener("selectionchange", noteSelection);
    return () => {
      selectedAllRef.current = false;
      document.removeEventListener("pointerdown", notePress, true);
      document.removeEventListener("keydown", noteKey, true);
      document.removeEventListener("selectionchange", noteSelection);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Showing another file drops a remembered Select All.
  }, [props.name, props.text]);
  const copyWholeFile = (event: ClipboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
    if (!root || !(selectsEveryMountedRow(root) ?? selectedAllRef.current)) return;
    event.clipboardData.setData("text/plain", props.text);
    event.preventDefault();
  };
  return (
    <DiffWorkerPoolProvider>
      <div ref={wrapperRef} className="contents" onCopy={copyWholeFile}>
        <Virtualizer
          key={`${props.name}:${resolvedTheme}:${props.text.length}`}
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={{
              name: props.name,
              contents: props.text,
              ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
            }}
            options={{
              disableFileHeader: true,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
}
