import { act, createRef, Suspense, use, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;
let uncaught: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  uncaught = [];
  root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
});

afterEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Editor({
  value,
  editorRef,
}: {
  value: string;
  editorRef?: React.RefObject<ComposerPromptEditorHandle | null>;
}) {
  const [, setDraft] = useState(value);
  const ownRef = useRef<ComposerPromptEditorHandle>(null);
  return (
    <ComposerPromptEditor
      editorRef={editorRef ?? ownRef}
      value={value}
      cursor={value.length}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={setDraft}
      onPaste={() => {}}
    />
  );
}

function Gate({ ready }: { ready: Promise<void> }) {
  use(ready);
  return null;
}

function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => (open = resolve));
  return { ready, open };
}

// A thread page: its data suspends, then the composer mounts as it reveals.
function Thread({ id, value, ready }: { id: string; value: string; ready: Promise<void> }) {
  return (
    <Suspense fallback={<p data-fallback={id} />}>
      <Gate ready={ready} />
      <Editor key={id} value={value} />
    </Suspense>
  );
}

const editorText = () => container.querySelector('[data-testid="composer-editor"]')?.textContent;

// Resolves once the predicate holds, or rejects with the commit error.
function rendered(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      if (uncaught.length > 0) reject(uncaught[0]);
      else if (predicate()) resolve();
      else return;
      observer.disconnect();
    };
    const observer = new MutationObserver(settle);
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    settle();
  });
}

it("mounts the composer in a throttled Suspense reveal", async () => {
  // React holds a reveal that follows a fallback for up to 300ms after the
  // render, long enough for @tiptap/react to destroy the uncommitted editor.
  // act() skips that throttle, so this renders the way the app does.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);

  const threadA = gate();
  root.render(<Thread id="a" value="thread a draft" ready={threadA.ready} />);
  await rendered(() => container.querySelector('[data-fallback="a"]') !== null);
  threadA.open();
  await rendered(() => editorText() === "thread a draft");

  // Rapid thread switches: each one suspends, then reveals a fresh composer.
  const threadB = gate();
  root.render(<Thread id="b" value="thread b draft" ready={threadB.ready} />);
  const threadAAgain = gate();
  root.render(<Thread id="a" value="thread a edited" ready={threadAAgain.ready} />);
  threadB.open();
  threadAAgain.open();
  await rendered(() => editorText() === "thread a edited");
  expect(uncaught).toEqual([]);
});

it("defers controlled values while the editor view is unmounted", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await act(async () => root.render(<Editor value="before" editorRef={editorRef} />));
  const editorElement = container.querySelector('[data-testid="composer-editor"]') as
    | (HTMLElement & { editor?: { unmount: () => void } })
    | null;
  const tiptap = editorElement?.editor;
  if (!tiptap) throw new Error("Composer editor did not mount");

  await act(async () => {
    tiptap.unmount();
    // Until React swaps in a new editor, the handle and the controlled value
    // still reach the one without a view.
    expect(() => editorRef.current?.focusAtEnd()).not.toThrow();
    expect(editorRef.current?.isCaretOnVisualEdge("start")).toBe(false);
    root.render(<Editor value="after unmount" editorRef={editorRef} />);
  });
  expect(uncaught).toEqual([]);
  expect(editorText()).toBe("after unmount");
});
