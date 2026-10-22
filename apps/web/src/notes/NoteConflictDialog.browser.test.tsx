import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { NoteConflictDialog } from "./NoteConflictDialog";
import { compareNoteLines, NoteSession } from "./noteState";
import type { NoteDocument } from "@goat/contracts";

vi.mock("./noteState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./noteState")>();
  return { ...actual, compareNoteLines: vi.fn(actual.compareNoteLines) };
});
vi.mock("../components/ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => children;
  return {
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? children : null,
    DialogPopup: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: Wrapper,
    DialogDescription: Wrapper,
    DialogPanel: Wrapper,
    DialogFooter: Wrapper,
  };
});
const document: NoteDocument = {
  path: "note.md",
  folder: null,
  title: "Note",
  body: "disk",
  status: "idea",
  threads: [],
  updatedBy: "user",
  revision: "a".repeat(64),
  updatedAt: "2026-10-20T00:00:00.000Z",
  size: 4,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(compareNoteLines).mockClear();
  container = window.document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it("does no comparison work while closed and memoizes open comparisons by both bodies", async () => {
  const session = new NoteSession(document, vi.fn());
  session.compare(document);
  const render = async (open: boolean, canWrite = true) => {
    await act(async () =>
      root.render(
        <NoteConflictDialog
          state={session.getSnapshot()}
          open={open}
          canWrite={canWrite}
          onOpenChange={vi.fn()}
          onTheirs={vi.fn()}
          onMine={vi.fn()}
        />,
      ),
    );
  };
  await render(false);
  session.edit("first draft");
  await render(false);
  expect(compareNoteLines).not.toHaveBeenCalled();
  await render(true);
  expect(compareNoteLines).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("+ first draft");
  await render(true, false);
  session.edit("first draft", "doing");
  await render(true);
  expect(compareNoteLines).toHaveBeenCalledTimes(1);
  session.edit("second draft");
  await render(true);
  expect(compareNoteLines).toHaveBeenCalledTimes(2);
  session.compare({ ...document, body: "new disk" });
  await render(true);
  expect(compareNoteLines).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("− new disk");
  await render(false);
  session.edit("closed edit");
  await render(false);
  expect(compareNoteLines).toHaveBeenCalledTimes(3);
  await render(true);
  expect(compareNoteLines).toHaveBeenCalledTimes(4);
  expect(container.textContent).toContain("+ closed edit");
});
