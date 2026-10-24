import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { buildFleet, type FleetShell } from "@goat/client-runtime/state/fleet";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { THREAD_CONTEXT_DROP_EVENT, threadContextDropTargetProps } from "../chat/threadContextDrag";
import type { FleetThread } from "@goat/client-runtime/state/fleet";
import type { ScopedThreadRef } from "@goat/contracts";

import { FleetThreadList } from "./FleetThreadList";

const local = EnvironmentId.make("local");
const codex = ProviderInstanceId.make("codex");
const at = (minute: number) => `2026-10-17T00:${String(minute).padStart(2, "0")}:00.000Z`;

function shell(
  id: string,
  createdMinute: number,
  options: {
    readonly status?: NonNullable<FleetShell["runtime"]>["status"];
    readonly approval?: boolean;
    readonly updatedMinute?: number;
  } = {},
): FleetShell {
  const updatedAt = at(options.updatedMinute ?? createdMinute);
  return {
    environmentId: local,
    id: ThreadId.make(id),
    title: id,
    providerInstanceId: codex,
    runtime: {
      status: options.status ?? "running",
      activeRunId: null,
      providerInstanceId: codex,
      providerName: null,
      lastError: null,
      updatedAt,
    },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    sideChatOf: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    createdAt: at(createdMinute),
    updatedAt,
    source: {},
  };
}

function threads(shells: ReadonlyArray<FleetShell>) {
  return buildFleet({
    environments: [{ environmentId: local, label: "Mac", sshAliases: [] }],
    primaryEnvironmentId: local,
    shells,
    remote: [],
  }).threads;
}
const rows = (container: HTMLElement) => [...container.querySelectorAll("li")];
const titles = (container: HTMLElement) =>
  rows(container).map((row) => row.querySelector(".truncate")?.textContent);

it("keeps rows in place as threads stream, change state, finish and join", async () => {
  await using screen = await render(
    <FleetThreadList
      threads={threads([shell("first", 1), shell("second", 2), shell("third", 3)])}
    />,
  );
  const before = rows(screen.container);
  await screen.rerender(
    <FleetThreadList
      threads={threads([
        shell("third", 3, { updatedMinute: 40 }),
        shell("first", 1),
        shell("second", 2, { approval: true }),
      ])}
    />,
  );
  expect(titles(screen.container)).toEqual(["first", "second", "third"]);
  expect(rows(screen.container).every((row, index) => row === before[index])).toBe(true);
  await expect.element(screen.getByText("Needs you")).toBeVisible();
  await screen.rerender(
    <FleetThreadList
      threads={threads([
        shell("first", 1),
        shell("second", 2, { status: "completed" }),
        shell("third", 3),
        shell("fourth", 9),
      ])}
    />,
  );
  expect(titles(screen.container)).toEqual(["first", "third", "fourth"]);
  expect(rows(screen.container)[0]).toBe(before[0]);
  expect(rows(screen.container)[1]).toBe(before[2]);
});

function pointer(type: string, y: number, buttons = 1) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons,
    clientX: 20,
    clientY: y,
  });
}

it("drops a remote Fleet thread vertically into a composer without navigating", async () => {
  const remote = EnvironmentId.make("remote");
  const ref = { environmentId: remote, threadId: ThreadId.make("remote-work") };
  const thread: FleetThread = {
    ...threads([shell("first", 1)])[0]!,
    key: "remote-work",
    ref,
    title: "Remote work",
    subagents: [{ key: "sub", title: "Worker", status: "running" }],
  };
  await using screen = await render(
    <>
      <FleetThreadList
        threads={[
          thread,
          { ...thread, key: "reported", ref: null, title: "Reported only", subagents: [] },
        ]}
      />
      <form {...threadContextDropTargetProps()} aria-label="Composer" />
    </>,
    { router: "/fleet" },
  );
  const composer = screen.getByRole("form").element();
  const drops: ReadonlyArray<ScopedThreadRef>[] = [];
  composer.addEventListener(THREAD_CONTEXT_DROP_EVENT, (event) =>
    drops.push((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail),
  );
  using _hitTest = vi
    .spyOn(document, "elementFromPoint")
    .mockImplementation((_x, y) => (y > 100 ? composer : null));
  const link = screen.getByRole("link", { name: "Remote work" }).element();
  await act(() => {
    link.dispatchEvent(pointer("pointerdown", 20));
    document.dispatchEvent(pointer("pointermove", 140));
    document.dispatchEvent(pointer("pointerup", 140, 0));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });
  expect(drops).toEqual([[ref]]);
  expect(screen.router!.state.location.pathname).toBe("/fleet");
  expect(link.getAttribute("draggable")).toBe("false");
  await act(() => {
    link.dispatchEvent(pointer("pointerdown", 20));
    document.dispatchEvent(pointer("pointermove", 140));
    document.dispatchEvent(pointer("pointercancel", 140));
    document.dispatchEvent(pointer("pointerup", 140, 0));
  });
  for (const target of [
    screen.getByRole("button", { name: /1 subagent/ }).element(),
    screen.getByText("Reported only").element(),
  ]) {
    await act(() => {
      target.dispatchEvent(pointer("pointerdown", 20));
      document.dispatchEvent(pointer("pointermove", 140));
      document.dispatchEvent(pointer("pointerup", 140, 0));
    });
  }
  expect(drops).toHaveLength(1);
  await act(() => {
    link.dispatchEvent(pointer("pointerdown", 20));
    document.dispatchEvent(pointer("pointerup", 20, 0));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await vi.waitFor(() =>
    expect(screen.router!.state.location.pathname).toBe("/remote/remote-work"),
  );
});
