import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { foldLaunchedThreads, type LaunchFoldThread } from "./launchFold";
import { NOW, key, thread } from "./launchFold.fixtures";
import { SidebarLaunchGroup } from "./SidebarLaunchGroup";
import { useLaunchGroups } from "./useLaunchGroups";

const keyOf = (entry: LaunchFoldThread) =>
  scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id));

function LaunchList(props: {
  readonly threads: readonly LaunchFoldThread[];
  readonly route: string | null;
}) {
  const fold = foldLaunchedThreads({ visible: props.threads, all: props.threads, now: NOW });
  const groups = useLaunchGroups(fold, props.route);
  const renderEntry = (entry: LaunchFoldThread) => {
    const entryKey = keyOf(entry);
    const children = fold.childrenByParentKey.get(entryKey);
    return (
      <li key={entryKey}>
        <span>{String(entry.id)}</span>
        {children ? (
          <SidebarLaunchGroup
            parentKey={entryKey}
            children={children}
            shownChildren={groups.shownChildren(entryKey)}
            expanded={groups.isExpanded(entryKey)}
            onToggle={groups.toggle}
            onShowAll={groups.showAll}
            renderRow={renderEntry}
          />
        ) : null}
      </li>
    );
  };
  return (
    <>
      <ul aria-label="Threads">{fold.roots.map(renderEntry)}</ul>
      <output aria-label="Order">{groups.renderedOrder(fold.roots.map(keyOf)).join(" ")}</output>
    </>
  );
}

function setup() {
  localStorage.removeItem("goat:sidebar:launch-groups-expanded");
}

const lanes = (count: number, options: Parameters<typeof thread>[1] = {}) =>
  Array.from({ length: count }, (_, index) =>
    thread(`lane-${index + 1}`, {
      launchedBy: "coordinator",
      createdAt: `2026-10-27T10:${String(index).padStart(2, "0")}:00.000Z`,
      ...options,
    }),
  );

describe("SidebarLaunchGroup", () => {
  it("folds launched threads into one line that expands into their rows", async () => {
    setup();
    const threads = [
      thread("coordinator"),
      ...lanes(2, { status: "running" }),
      thread("asking", { launchedBy: "coordinator", input: true }),
    ];
    await using screen = await render(<LaunchList threads={threads} route={null} />, {
      // No router: the route arrives as a prop.
      router: false,
    });
    const line = screen.getByRole("button", {
      name: "Launched threads: 3 threads · 2 running · 1 needs you",
    });
    await expect.element(line).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("lane-1")).not.toBeInTheDocument();

    await line.click();
    await expect.element(screen.getByText("lane-1")).toBeVisible();
    await expect
      .element(screen.getByRole("status", { name: "Order" }))
      .toHaveTextContent(
        [key("coordinator"), key("asking"), key("lane-1"), key("lane-2")].join(" "),
      );
  });

  it("remembers a launcher's expansion after the sidebar remounts", async () => {
    setup();
    const threads = [thread("coordinator"), ...lanes(1)];
    {
      await using first = await render(<LaunchList threads={threads} route={null} />, {
        // No router: the route arrives as a prop.
        router: false,
      });
      await first.getByRole("button", { name: /^Launched threads/ }).click();
    }
    await using screen = await render(<LaunchList threads={threads} route={null} />, {
      // No router: the route arrives as a prop.
      router: false,
    });
    await expect.element(screen.getByText("lane-1")).toBeVisible();
  });

  it("lists five launched threads and reveals the rest on +N more", async () => {
    setup();
    await using screen = await render(
      <LaunchList threads={[thread("coordinator"), ...lanes(7)]} route={null} />,
      // No router: the route arrives as a prop.
      { router: false },
    );
    await screen.getByRole("button", { name: /^Launched threads/ }).click();
    await expect.element(screen.getByText("lane-5")).toBeVisible();
    await expect.element(screen.getByText("lane-6")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "+2 more" }).click();
    await expect.element(screen.getByText("lane-7")).toBeVisible();
  });

  it("opens every group on the way to a routed thread past the limit", async () => {
    setup();
    const threads = [
      thread("coordinator"),
      ...lanes(7),
      thread("grandchild", { launchedBy: "lane-7", status: "running" }),
    ];
    await using screen = await render(
      <LaunchList threads={threads} route={key("grandchild")} />,
      // No router: the route arrives as a prop.
      { router: false },
    );
    await expect.element(screen.getByText("grandchild")).toBeVisible();
    await expect
      .element(screen.getByRole("status", { name: "Order" }))
      .toHaveTextContent(
        [
          key("coordinator"),
          ...Array.from({ length: 7 }, (_, index) => key(`lane-${index + 1}`)),
          key("grandchild"),
        ].join(" "),
      );
  });
});
