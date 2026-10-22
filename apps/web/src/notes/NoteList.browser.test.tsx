import type { NoteSummary } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { NoteList } from "./NoteList";

const summary = (
  path: string,
  title: string,
  updatedAt: string,
  extra: Partial<NoteSummary> = {},
) =>
  ({
    path,
    folder: path.includes("/") ? path.split("/")[0]! : null,
    title,
    status: "idea",
    threads: [],
    updatedBy: "user",
    revision: "a".repeat(64),
    updatedAt,
    size: 10,
    pinned: false,
    preview: "",
    related: [],
    ...extra,
  }) as NoteSummary;

const notes = [
  summary("old.md", "Old idea", "2026-10-01T00:00:00.000Z"),
  summary("goat/plan.md", "Rail plan", "2026-10-20T00:00:00.000Z", { preview: "move notes" }),
  summary("오늘.md", "오늘 할 일", "2026-10-22T00:00:00.000Z"),
  summary("goat/checklist.md", "Merge checklist", "2026-09-01T00:00:00.000Z", { pinned: true }),
];

async function renderList(query = "") {
  const onSelect = vi.fn();
  const onOpenEditor = vi.fn();
  const onQueryChange = vi.fn();
  const screen = await render(
    <NoteList
      notes={notes}
      selectedPath={undefined}
      query={query}
      onQueryChange={onQueryChange}
      onSelect={onSelect}
      onOpenEditor={onOpenEditor}
      onCreate={vi.fn()}
      createShortcut={null}
    />,
  );
  const rows = () =>
    [...screen.container.querySelectorAll<HTMLElement>("[data-note-row]")].map(
      (row) => row.dataset.noteRow,
    );
  return { screen, rows, onSelect, onOpenEditor, onQueryChange };
}

it("puts pinned notes first, then the most recently updated", async () => {
  const { screen, rows } = await renderList();
  await using _screen = screen;
  expect(rows()).toEqual(["goat/checklist.md", "오늘.md", "goat/plan.md", "old.md"]);
  await expect.element(screen.getByText("Pinned")).toBeVisible();
});

it("filters by title, preview, and folder, including Korean", async () => {
  const korean = await renderList("오늘");
  await using _korean = korean.screen;
  expect(korean.rows()).toEqual(["오늘.md"]);
  const folder = await renderList("goat move");
  await using _folder = folder.screen;
  expect(folder.rows()).toEqual(["goat/plan.md"]);
});

it("walks the list with the arrow keys and opens the editor with Enter", async () => {
  const { screen, onSelect, onOpenEditor } = await renderList();
  await using _screen = screen;
  await userEvent.click(screen.getByRole("searchbox", { name: "Search notes" }));
  await userEvent.keyboard("{ArrowDown}");
  expect(onSelect).toHaveBeenLastCalledWith("goat/checklist.md", { replace: true });
  await userEvent.keyboard("{ArrowDown}");
  expect(onSelect).toHaveBeenLastCalledWith("오늘.md", { replace: true });
  expect(document.activeElement?.getAttribute("data-note-row")).toBe("오늘.md");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith("오늘.md");
  expect(onOpenEditor).toHaveBeenCalledTimes(1);
});

it("offers to open a path the list does not hold", async () => {
  const { screen, onSelect } = await renderList("archive/older.md");
  await using _screen = screen;
  await userEvent.click(screen.getByRole("button", { name: "Open archive/older.md" }));
  expect(onSelect).toHaveBeenCalledWith("archive/older.md");
});
