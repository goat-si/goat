import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { ThreadId } from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { foldLaunchedThreads, type LaunchFoldThread } from "@goat/client-runtime/state/launch-fold";
import { NOW, key, thread } from "@goat/client-runtime/state/launch-fold-fixtures";
import { SidebarLaunchGroup } from "./SidebarLaunchGroup";
import { resetLaunchGroupSession, useLaunchGroups } from "./useLaunchGroups";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

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
            threads={children}
            stateByKey={fold.stateByKey}
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
  resetLaunchGroupSession();
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
  it("gives each launched row the variant of the row directly above it", async () => {
    setup();
    await page.viewport(1400, 900);
    const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
    const launchedBy = (parent: string) => ({
      kind: "launch" as const,
      threadId: ThreadId.make(parent),
      environmentId: null,
      environmentLabel: null,
      threadTitle: null,
      via: "thread_launch" as const,
    });
    const fixture = (id: string, title: string) => ({ ...threadWithHistory(id, 0), title });
    using _environment = installFakeEnvironment(
      [
        fixture("coordinator", "Coordinator"),
        {
          ...fixture("settled", "Settled lane"),
          shell: {
            launchedBy: launchedBy("coordinator"),
            settledOverride: "settled",
            settledAt: at,
          },
        },
        {
          ...fixture("snoozed", "Snoozed lane"),
          shell: {
            launchedBy: launchedBy("coordinator"),
            snoozedAt: at,
            snoozedUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
          },
        },
        {
          ...fixture("sublane", "Settled sublane"),
          shell: { launchedBy: launchedBy("snoozed"), settledOverride: "settled", settledAt: at },
        },
      ],
      { capabilities: { threadSnooze: true, threadSettlement: true } },
    );
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
    await router.load();
    await using screen = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    await expect
      .element(screen.getByRole("treeitem", { name: /^Coordinator/ }))
      .toHaveAttribute("data-testid", "sidebar-row-card");
    await screen.getByRole("button", { name: /^Launched threads/ }).click();
    await expect
      .element(screen.getByRole("treeitem", { name: /^Settled lane/ }))
      .toHaveAttribute("data-testid", "sidebar-row-card");
    await expect
      .element(screen.getByRole("treeitem", { name: /^Snoozed lane/ }))
      .toHaveAttribute("data-testid", "sidebar-row-slim");
    await screen
      .getByRole("button", { name: /^Launched threads/ })
      .last()
      .click();
    await expect
      .element(screen.getByRole("treeitem", { name: /^Settled sublane/ }))
      .toHaveAttribute("data-testid", "sidebar-row-slim");
  });
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
        [key("coordinator"), key("asking"), key("lane-2"), key("lane-1")].join(" "),
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
    await expect.element(screen.getByText("lane-3")).toBeVisible();
    await expect.element(screen.getByText("lane-2")).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "+2 more" }).click();
    await expect.element(screen.getByText("lane-1")).toBeVisible();
  });

  it("opens every group on the way to a routed thread past the limit", async () => {
    setup();
    const threads = [
      thread("coordinator"),
      ...lanes(7),
      thread("grandchild", { launchedBy: "lane-1" }),
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
          ...Array.from({ length: 7 }, (_, index) => key(`lane-${7 - index}`)),
          key("grandchild"),
        ].join(" "),
      );
  });
});
