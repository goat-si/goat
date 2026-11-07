import type { NoteSummary } from "@goat/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { NoteList } from "./NoteList";
import {
  NotesListToggle,
  toggleNotesListCollapsed,
  useNotesListHidden,
  useNotesListKeyboard,
} from "./notesListCollapse";
import { markNotesPageOpen } from "./notesPageVisibility";

const KEY = "goat:notes:list-collapsed";
const note = {
  path: "plan.md",
  folder: null,
  title: "Plan",
  status: "idea",
  threads: [],
  updatedBy: "user",
  revision: "a".repeat(64),
  updatedAt: "2026-11-01T00:00:00.000Z",
  size: 10,
  pinned: false,
  preview: "",
  related: [],
} as unknown as NoteSummary;

// The same composition as NotesPage: header toggle, list hidden by the preference, page keyboard.
function NotesLayout() {
  const hidden = useNotesListHidden();
  useNotesListKeyboard(DEFAULT_RESOLVED_KEYBINDINGS);
  return (
    <div>
      <NotesListToggle keybindings={DEFAULT_RESOLVED_KEYBINDINGS} />
      <div className="flex">
        <NoteList
          notes={[note]}
          selectedPath={undefined}
          query=""
          onQueryChange={vi.fn()}
          onSelect={vi.fn()}
          onOpenEditor={vi.fn()}
          onCreate={null}
          createShortcut={null}
          hidden={hidden}
          className="w-full md:w-80"
        />
        <main>
          <p>Editor</p>
        </main>
      </div>
    </div>
  );
}

async function setup(width = 1280) {
  localStorage.removeItem(KEY);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 800);
  const closePage = markNotesPageOpen();
  return {
    async [Symbol.asyncDispose]() {
      closePage();
      localStorage.removeItem(KEY);
      await page.viewport(viewport.width, viewport.height);
    },
  };
}

const list = () => document.getElementById("notes-list")!;
const toggle = () => document.getElementById("notes-list-toggle")!;
const isShown = (element: HTMLElement) => element.offsetParent !== null;
const modBackslash = navigator.platform.includes("Mac")
  ? "{Meta>}\\{/Meta}"
  : "{Control>}\\{/Control}";

it("hides and shows the list from the header button and remembers the choice", async () => {
  await using _setup = await setup();
  await using screen = await render(<NotesLayout />);
  const button = screen.getByRole("button", { name: "Hide notes list" });
  await expect.element(button).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(button);
  await vi.waitFor(() => expect(isShown(list())).toBe(false));
  await expect
    .element(screen.getByRole("button", { name: "Show notes list" }))
    .toHaveAttribute("aria-expanded", "false");
  expect(localStorage.getItem(KEY)).toBe("true");

  await act(() => screen.unmount());
  await using again = await render(<NotesLayout />);
  await expect.element(again.getByRole("button", { name: "Show notes list" })).toBeVisible();
  expect(isShown(list())).toBe(false);
});

it("toggles with the shortcut, and slash brings a hidden list back to search", async () => {
  await using _setup = await setup();
  await using _screen = await render(<NotesLayout />);
  await userEvent.keyboard(modBackslash);
  await vi.waitFor(() => expect(isShown(list())).toBe(false));
  await userEvent.keyboard("/");
  await vi.waitFor(() => expect(isShown(list())).toBe(true));
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector("[data-notes-search]")),
  );
});

it("moves focus to the toggle when the focused list hides, even from another tab", async () => {
  await using _setup = await setup();
  await using _screen = await render(<NotesLayout />);
  document.querySelector<HTMLElement>("[data-note-row]")!.focus();
  await act(() => {
    localStorage.setItem(KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(toggle()));
});

it("waits for an open dialog to release the page before focusing, and gives up if the list returns", async () => {
  await using _setup = await setup();
  await using screen = await render(<NotesLayout />);
  const row = document.querySelector<HTMLElement>("[data-note-row]")!;
  row.focus();
  screen.container.setAttribute("inert", "");
  await act(() => toggleNotesListCollapsed());
  expect(document.activeElement).not.toBe(toggle());
  await act(() => screen.container.removeAttribute("inert"));
  await vi.waitFor(() => expect(document.activeElement).toBe(toggle()));

  await act(() => toggleNotesListCollapsed());
  row.focus();
  screen.container.setAttribute("inert", "");
  await act(() => toggleNotesListCollapsed());
  await act(() => toggleNotesListCollapsed());
  await act(() => screen.container.removeAttribute("inert"));
  expect(isShown(list())).toBe(true);
  expect(document.activeElement).not.toBe(toggle());
});

it("leaves the preference alone on a narrow screen and applies it when the screen widens", async () => {
  await using _setup = await setup(500);
  await using _screen = await render(<NotesLayout />);
  await userEvent.keyboard(modBackslash);
  expect(localStorage.getItem(KEY)).toBeNull();

  document.querySelector<HTMLElement>("[data-note-row]")!.focus();
  await act(() => {
    localStorage.setItem(KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  });
  expect(isShown(list())).toBe(true);
  expect(document.activeElement).toBe(document.querySelector("[data-note-row]"));

  await page.viewport(1280, 800);
  await vi.waitFor(() => expect(isShown(list())).toBe(false));
  await vi.waitFor(() => expect(document.activeElement).toBe(toggle()));
});
