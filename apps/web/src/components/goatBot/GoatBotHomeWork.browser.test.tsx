import { EnvironmentId, ThreadId, type BotThreadRow } from "@goat/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  show: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  permit: true,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => actions.permit,
}));
vi.mock("~/localApi", () => {
  const api = () => ({ contextMenu: { show: actions.show } });
  return { readLocalApi: api, ensureLocalApi: api };
});
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    updateTaskView: { permissionAtom: () => "permission", execute: actions.update },
    listChildWork: () => null,
    remoteWorkOpenable: () => "openable",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof actions.update }) => command.execute,
}));
vi.mock("~/state/environments", () => ({ useEnvironment: () => null }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  }),
}));

import { GoatBotHomeWork } from "./GoatBotHomeWork";

const environmentId = EnvironmentId.make("env");

type Row = Extract<BotThreadRow, { kind: "task" }>;

function taskRow(
  taskId: string,
  title: string,
  status: string,
  at: string,
  extra: { unread?: boolean; doneAt?: string | null } = {},
): Row {
  return {
    kind: "task",
    task: { taskId, title, status, updatedAt: at },
    view: { taskId, pinnedAt: null, doneAt: extra.doneAt ?? null, readThrough: null },
    lastActivityAt: at,
    unread: extra.unread ?? false,
    mainMessagesSinceQuiet: 0,
  } as unknown as Row;
}

function setup(rows: Row[] = []) {
  actions.permit = true;
  actions.show.mockReset();
  actions.show.mockResolvedValue(null);
  actions.update.mockReset();
  actions.update.mockResolvedValue({ _tag: "Success" });
  actions.refresh.mockReset();
  return rows;
}

function view(rows: readonly Row[], overrides: Record<string, unknown> = {}) {
  return (
    <GoatBotHomeWork
      environmentId={environmentId}
      threadId={ThreadId.make("bot")}
      botName="GOAT Bot"
      rows={rows}
      remoteWork={[]}
      loaded
      failed={false}
      failure={null}
      onRetry={actions.refresh}
      onOpenTask={() => {}}
      showAll={false}
      onShowAllChange={() => {}}
      {...overrides}
    />
  );
}

/** The order the task titles are offered in, read from the buttons that open them. */
const titles = (screen: Awaited<ReturnType<typeof render>>, names: readonly string[]) =>
  screen
    .getByRole("button", { name: new RegExp(`^(${names.join("|")})`) })
    .elements()
    .map((element) => names.find((name) => element.textContent?.startsWith(name)));

it("shows running work, then what waits on a person, then what finished, newest first", async () => {
  setup();
  const rows = [
    taskRow("done-old", "Old finish", "completed", "2026-11-08T01:00:00.000Z"),
    taskRow("running-old", "Older run", "running", "2026-11-09T01:00:00.000Z"),
    taskRow("waiting", "Needs an answer", "waiting_input", "2026-11-09T02:00:00.000Z"),
    taskRow("running-new", "Newer run", "running", "2026-11-09T03:00:00.000Z"),
  ];
  await using screen = await render(view(rows));
  const order = ["Newer run", "Older run", "Needs an answer", "Old finish"];
  await expect.element(screen.getByRole("button", { name: /^Newer run/ })).toBeVisible();
  expect(titles(screen, order)).toEqual(order);
});

it("moves Pin onto the row with the sidebar's input", async () => {
  const rows = setup([taskRow("task-a", "Stop the port", "running", "2026-11-09T01:00:00.000Z")]);
  actions.show.mockResolvedValueOnce("pin");
  await using screen = await render(view(rows));
  await userEvent.click(screen.getByRole("button", { name: "Actions for Stop the port" }));
  expect(actions.show).toHaveBeenCalledOnce();
  expect(actions.update).toHaveBeenCalledWith({
    environmentId,
    input: { taskId: "task-a", pinned: true },
  });
});

it("Mark done reopens a finished task and Mark read clears its mark", async () => {
  const rows = setup([
    taskRow("task-done", "Finished work", "completed", "2026-11-09T01:00:00.000Z", {
      doneAt: "2026-11-09T01:00:00.000Z",
      unread: true,
    }),
  ]);
  await using screen = await render(view(rows));
  actions.show.mockResolvedValueOnce("done");
  await userEvent.click(screen.getByRole("button", { name: "Actions for Finished work" }));
  expect(actions.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { taskId: "task-done", done: false },
  });
  actions.show.mockResolvedValueOnce("read");
  await userEvent.click(screen.getByRole("button", { name: "Actions for Finished work" }));
  expect(actions.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { taskId: "task-done", readThrough: "2026-11-09T01:00:00.000Z" },
  });
  expect(actions.refresh).toHaveBeenCalledTimes(2);
});

it("offers only Show work in the row menu when this device may not change the view", async () => {
  const rows = setup([taskRow("task-a", "Stop the port", "running", "2026-11-09T01:00:00.000Z")]);
  actions.permit = false;
  await using screen = await render(view(rows));
  await userEvent.click(screen.getByRole("button", { name: "Actions for Stop the port" }));
  expect(actions.show).toHaveBeenCalledWith(
    [{ id: "work", label: "Show work" }],
    expect.anything(),
  );
  expect(actions.update).not.toHaveBeenCalled();
});

it("says Unread on the control that opens an unread task", async () => {
  const rows = setup([
    taskRow("task-a", "Stop the port", "running", "2026-11-09T01:00:00.000Z", { unread: true }),
  ]);
  await using screen = await render(view(rows));
  await expect
    .element(screen.getByRole("button", { name: /^Stop the port.*Unread/ }))
    .toBeVisible();
});

it("ends a long list with a centred Show more row that shows the rest", async () => {
  const rows = setup(
    Array.from({ length: 7 }, (_, index) =>
      taskRow(
        `task-${index}`,
        `Finished ${index + 1}`,
        "completed",
        `2026-11-0${index + 1}T01:00:00.000Z`,
      ),
    ),
  );
  await using screen = await render(<Expandable rows={rows} />);
  await expect.element(screen.getByText("Finished 7")).not.toBeInTheDocument();
  const more = screen.getByRole("button", { name: "Show more" });
  await expect.element(more).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(more);
  await expect.element(screen.getByText("Finished 7")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
});

/** The panel holds Work's tail state; this stands in for it. */
function Expandable({ rows }: { readonly rows: readonly Row[] }) {
  const [showAll, setShowAll] = useState(false);
  return view(rows, { showAll, onShowAllChange: setShowAll });
}

it("says it is loading while the first read runs, not an empty claim", async () => {
  const rows = setup([]);
  await using screen = await render(view(rows, { loaded: false }));
  expect(screen.container.textContent).toContain("Loading tasks…");
  expect(screen.container.textContent).not.toContain("No recent tasks");
});

it("a failed read keeps the rows it knew and offers one retry", async () => {
  const rows = setup([taskRow("task-a", "Stop the port", "running", "2026-11-09T01:00:00.000Z")]);
  await using screen = await render(view(rows, { loaded: false, failed: true }));
  await expect.element(screen.getByText("Couldn't load GOAT Bot's tasks.")).toBeVisible();
  await expect.element(screen.getByText("Stop the port")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(actions.refresh).toHaveBeenCalledOnce();
});

it("an access-denied read explains itself and offers no retry that can never succeed", async () => {
  const denied = Object.assign(new Error("no"), {
    _tag: "EnvironmentAuthorizationError",
    requiredScope: "channel:read",
  });
  const rows = setup([]);
  await using screen = await render(view(rows, { loaded: false, failed: true, failure: denied }));
  await expect.element(screen.getByText("This device can't read GOAT Bot's work.")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Try again");
});

it("an empty list claims only recent work and offers the one next action", async () => {
  const rows = setup([]);
  await using screen = await render(view(rows));
  await expect.element(screen.getByText("No recent tasks")).toBeVisible();
  await expect.element(screen.getByText(/Ask GOAT Bot in chat to start work/)).toBeVisible();
  await expect
    .element(
      screen.getByText(/Unpinned tasks that finished more than three days ago aren't listed here/),
    )
    .toBeVisible();
});

it("says the computer is offline instead of loading forever, and an unsupported read never loads", async () => {
  const rows = setup([]);
  await using screen = await render(view(rows, { loaded: false, supported: false, offline: true }));
  await expect
    .element(screen.getByText("GOAT Bot's tasks are unavailable while the computer is offline."))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Loading tasks");
  await screen.rerender(view(rows, { loaded: false, supported: false }));
  await expect.element(screen.getByText(/Tasks can't be listed from this server/)).toBeVisible();
  expect(screen.container.textContent).not.toContain("Loading tasks");
});

it("the row's chevron opens the task, and Show work and Hide work live in its menu", async () => {
  const rows = setup([taskRow("task-a", "Stop the port", "running", "2026-11-09T01:00:00.000Z")]);
  const onOpenTask = vi.fn();
  await using screen = await render(view(rows, { onOpenTask }));
  const chevron = screen.container.querySelector("[data-work-chevron]");
  expect(chevron).not.toBeNull();
  await userEvent.click(chevron as Element);
  expect(onOpenTask).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Show work" }).query()).toBeNull();
  const actionsButton = screen.getByRole("button", { name: "Actions for Stop the port" });
  actions.show.mockResolvedValueOnce("work");
  await userEvent.click(actionsButton);
  expect(actions.show.mock.calls[0]?.[0]).toEqual([
    { id: "work", label: "Show work" },
    { id: "pin", label: "Pin" },
    { id: "done", label: "Mark done" },
    { id: "read", label: "Mark read", disabled: true },
  ]);
  await userEvent.click(actionsButton);
  expect(actions.show.mock.calls[1]?.[0]?.[0]).toEqual({ id: "work", label: "Hide work" });
  expect(onOpenTask).toHaveBeenCalledOnce();
  expect(actions.update).not.toHaveBeenCalled();
});
