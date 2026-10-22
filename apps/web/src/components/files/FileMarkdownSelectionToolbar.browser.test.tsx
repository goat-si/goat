import { fakeTimers } from "../../../test/render";
import { EnvironmentId, ThreadId, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { composerTargetKey, DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { reviewCommentContextRecord } from "~/lib/composerContextRecords";
import {
  captureAssistantTextSelection,
  resolveAssistantCitationRange,
} from "~/lib/assistantTextSelection";
import { FileMarkdownSelectionToolbar } from "./FileMarkdownSelectionToolbar";

const target = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("destination-thread"),
};
let root: Root;
let timers: Disposable;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
const bounds = { left: 10, top: 10, right: 500, bottom: 400, width: 490, height: 390 };

beforeEach(() => {
  timers = fakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  host = document.createElement("div");
  viewport = document.createElement("div");
  viewport.innerHTML =
    "<h1>Handoff</h1><ul><li>Ship the <strong>selection</strong> toolbar</li><li>Then celebrate</li></ul><input type='checkbox' />";
  document.body.append(viewport, host);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect(bounds));
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => DOMRect.fromRect({ x: 20, y: 20, width: 120, height: 20 }),
  });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  timers[Symbol.dispose]();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<Parameters<typeof FileMarkdownSelectionToolbar>[0]> = {}) {
  await act(async () => {
    root.render(
      <FileMarkdownSelectionToolbar
        viewport={viewport}
        cwd="/workspace/project"
        relativePath="docs/handoff.md"
        composerDraftTarget={target}
        {...overrides}
      />,
    );
  });
}

function pointerDown(node: Element) {
  node.dispatchEvent(
    Object.assign(new MouseEvent("pointerdown", { bubbles: true, button: 0 }), {
      isPrimary: true,
    }),
  );
}

async function select(node: Node = viewport.querySelector("ul")!, keyboard = false) {
  await act(async () => {
    if (keyboard)
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
      );
    else pointerDown(node instanceof Element ? node : node.parentElement!);
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    if (!keyboard)
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 100, clientY: 40 }));
    await vi.runAllTimersAsync();
  });
}

function action() {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Add selection to chat"]');
}

it("quotes rendered list text with file identity into only the destination composer and clears after commit", async () => {
  await render();
  await select();
  expect(action()).not.toBeNull();
  const button = action()!;
  await act(async () => {
    // The real action preserves the native selection during its press.
    const press = Object.assign(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
      { isPrimary: true },
    );
    expect(button.dispatchEvent(press)).toBe(false);
    button.click();
  });
  const drafts = useComposerDraftStore.getState().draftsByThreadKey;
  expect(Object.keys(drafts)).toEqual([composerTargetKey(target)]);
  const draft = drafts[composerTargetKey(target)]!;
  expect(draft.reviewComments).toHaveLength(1);
  const comment = draft.reviewComments[0]!;
  expect(reviewCommentContextRecord(comment)).toMatchObject({
    kind: "review-comment",
    filePath: "/workspace/project/docs/handoff.md",
    rangeLabel: "Selected text",
    diff: "Ship the selection toolbar\nThen celebrate",
    fenceLanguage: "text",
  });
  expect(comment.sectionId).not.toBe("file:docs/handoff.md");
  expect(draft.prompt).toContain("goat-context://v1/review-comment/");
  expect(action()).toBeNull();
  expect(window.getSelection()?.isCollapsed).toBe(true);
});

it("does not offer an action without a composer target", async () => {
  await render({ composerDraftTarget: undefined });
  await select();
  expect(action()).toBeNull();
});

it("adds quotes to a draft composer before a server thread exists", async () => {
  const draftTarget = DraftId.make("draft-destination");
  await render({ composerDraftTarget: draftTarget });
  await select();
  await act(async () => action()!.click());
  expect(
    useComposerDraftStore.getState().draftsByThreadKey[draftTarget]!.reviewComments[0]!.diff,
  ).toBe("Ship the selection toolbar\nThen celebrate");
});

it("dismisses the floating action when the enclosing file viewport scrolls", async () => {
  await render();
  await select();
  expect(action()).not.toBeNull();
  // Another surface (e.g. a streaming chat transcript) scrolling keeps the action.
  const transcript = document.createElement("div");
  document.body.append(transcript);
  await act(async () => transcript.dispatchEvent(new Event("scroll")));
  expect(action()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("scroll")));
  expect(action()).toBeNull();
});

it("shows the action at release after ancestor autoscroll during a drag", async () => {
  await render();
  await act(async () => {
    const list = viewport.querySelector("ul")!;
    pointerDown(list);
    const range = document.createRange();
    range.selectNodeContents(list);
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    document.body.dispatchEvent(new Event("scroll"));
    await vi.runAllTimersAsync();
  });
  expect(action()).toBeNull();
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 150, clientY: 90 }));
    await vi.runAllTimersAsync();
  });
  expect(action()).not.toBeNull();
  expect(action()!.style.left).toBe("150px");
  expect(action()!.style.top).toBe("90px");
});

it("does not reopen a pending multi-click action at stale coordinates after ancestor scroll", async () => {
  await render();
  await act(async () => {
    const list = viewport.querySelector("ul")!;
    pointerDown(list);
    const range = document.createRange();
    range.selectNodeContents(list);
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    // A double-click release waits for the multi-click interval before opening.
    window.dispatchEvent(
      new MouseEvent("mouseup", { button: 0, detail: 2, clientX: 150, clientY: 90 }),
    );
    document.body.dispatchEvent(new Event("scroll"));
    await vi.runAllTimersAsync();
  });
  expect(action()).toBeNull();
});

it("keeps assistant citations resolvable across unselectable code headers", () => {
  const style = document.createElement("style");
  style.textContent = ".select-none { user-select: none; }";
  viewport.innerHTML =
    '<div data-assistant-citation-source="assistant"><p>Before</p><div class="select-none">example.ts</div><pre><code>run();</code></pre><p>After</p></div>';
  document.body.append(style);
  const source = viewport.firstElementChild as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(source);
  const selection = window.getSelection()!;
  selection.addRange(range);
  const captured = captureAssistantTextSelection(viewport, selection)!;
  expect(captured.selector).toEqual({
    text: "Before\nrun();\nAfter",
    start: 0,
    end: 19,
    prefix: "",
    suffix: "",
  });
  source.querySelector(".select-none")!.textContent = "renamed.ts";
  source.insertAdjacentHTML("afterbegin", "<p>Inserted</p>");
  const resolved = resolveAssistantCitationRange(source, captured.selector)!;
  expect(resolved.startContainer).toBe(source.querySelectorAll("p")[1]!.firstChild);
  expect(resolved.startOffset).toBe(0);
  expect(resolved.endContainer).toBe(source.lastElementChild!.firstChild);
  expect(resolved.endOffset).toBe(5);
});

it.each([
  { relativePath: "docs/other.md" },
  { cwd: "/workspace/other" },
  { composerDraftTarget: { ...target, threadId: ThreadId.make("other-thread") } },
  { composerDraftTarget: { ...target, environmentId: EnvironmentId.make("other-environment") } },
  { composerDraftTarget: DraftId.make("draft-destination") },
])("invalidates a captured selection when identity changes: %j", async (overrides) => {
  await render();
  await select();
  expect(action()).not.toBeNull();
  await render(overrides);
  expect(action()).toBeNull();
  // A late selectionchange from the previous surface cannot reopen the action.
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await vi.runAllTimersAsync();
  });
  expect(action()).toBeNull();
  expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
});

it("supports keyboard selection, Tab to the action, and Escape dismissal", async () => {
  await render();
  await select(undefined, true);
  expect(action()).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement).toBe(action());
  await act(async () =>
    action()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(action()).toBeNull();
  expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
});

it("leaves task checkbox clicks working and dismisses the old action", async () => {
  await render();
  await select();
  const checkbox = viewport.querySelector<HTMLInputElement>("input")!;
  const change = vi.fn();
  checkbox.addEventListener("change", change);
  await act(async () => {
    pointerDown(checkbox);
    checkbox.click();
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    await vi.runAllTimersAsync();
  });
  expect(checkbox.checked).toBe(true);
  expect(change).toHaveBeenCalledOnce();
  expect(action()).toBeNull();
});

it("rejects selections extending outside the file and ignores controls in the snippet", async () => {
  await render();
  const outside = document.createElement("p");
  outside.textContent = "Other panel";
  document.body.append(outside);
  await select(document.body);
  expect(action()).toBeNull();
  viewport.querySelector("li")!.insertAdjacentHTML("beforeend", "<button>Copy code</button>");
  await select();
  await act(async () => action()!.click());
  expect(
    useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(target)]!
      .reviewComments[0]!.diff,
  ).toBe("Ship the selection toolbar\nThen celebrate");
});

it("disables oversized quotes without silently truncating the selected text", async () => {
  await render();
  viewport.querySelector("ul")!.textContent = "x".repeat(
    COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS + 1,
  );
  await select();
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Selection is too long to quote"]',
  )!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
});
