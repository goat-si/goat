import { EnvironmentId, ThreadId, type NoteSummary } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  notes: [] as NoteSummary[],
  primary: "hub" as string,
  update: vi.fn(),
  write: vi.fn(),
  navigate: vi.fn(),
}));
// Every notes permission is granted; the hub, the thread and the summaries are under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { notes: state.notes, ready: true, truncated: false, removedPaths: new Set() },
    error: null,
  })) as never,
}));
vi.mock(import("../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  usePrimaryEnvironmentId: (() => state.primary) as never,
}));
vi.mock(import("./useNoteCommand"), async () => {
  const { notesRpc } = await import("../rpc/notes/atoms");
  return {
    useNoteCommand: ((command: unknown) =>
      command === notesRpc.update ? state.update : state.write) as never,
  };
});
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: (() => state.navigate) as never,
}));

import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { ThreadNotesButton } from "./ThreadNotesButton";

const environmentId = EnvironmentId.make("hub");
const threadId = ThreadId.make("thread-1");
const here = { threadId, host: null };
const note = (path: string, title: string, extra: Partial<NoteSummary> = {}) =>
  ({
    path,
    folder: null,
    title,
    status: "idea",
    threads: [],
    updatedBy: "user",
    revision: "a".repeat(64),
    updatedAt: "2026-10-22T00:00:00.000Z",
    size: 1,
    pinned: false,
    preview: "",
    related: [],
    ...extra,
  }) as NoteSummary;

function setup(notes: NoteSummary[], primary = "hub") {
  state.notes = notes;
  state.primary = primary;
  state.update.mockReset().mockResolvedValue({ ok: true, value: notes[0] });
  state.write.mockReset();
  state.navigate.mockReset();
  return render(
    <ThreadNotesButton environmentId={environmentId} threadId={threadId} projectTitle="goat" />,
  );
}

it("links a note to the thread it is opened from", async () => {
  await using screen = await setup([note("plan.md", "Rail plan")]);
  await userEvent.click(screen.getByRole("button", { name: "Notes for this thread" }));
  await userEvent.click(page.getByRole("button", { name: "Rail plan" }));
  expect(state.update).toHaveBeenCalledWith({
    environmentId,
    input: { path: "plan.md", relate: here },
  });
});

it("counts linked notes and unlinks only reference links", async () => {
  await using screen = await setup([
    note("plan.md", "Rail plan", { related: [here] }),
    note("work.md", "Started work", { threads: [{ ...here, lastResult: null }] }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Notes for this thread (2 linked)" }));
  await expect
    .element(page.getByRole("button", { name: "Unlink Started work" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Unlink Rail plan" }));
  expect(state.update).toHaveBeenCalledWith({
    environmentId,
    input: { path: "plan.md", unrelate: here },
  });
});

it("hides linking against a hub that predates it", async () => {
  const legacy = note("plan.md", "Rail plan");
  delete (legacy as { pinned?: boolean }).pinned;
  await using screen = await setup([legacy]);
  await userEvent.click(screen.getByRole("button", { name: "Notes for this thread" }));
  await expect
    .element(page.getByRole("button", { name: "New note for this thread" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("searchbox", { name: "Find a note to link" }))
    .not.toBeInTheDocument();
});

it("stays out of threads on machines other than the notes hub", async () => {
  await using screen = await setup([note("plan.md", "Rail plan")], "other-hub");
  expect(screen.container.querySelector("button")).toBeNull();
});
