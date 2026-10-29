import { RegistryProvider } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import { ShowBotThreadsSetting } from "../settings/ShowBotThreadsSetting";
import { partitionSidebarThreads } from "./sidebarPartition";
import { useBotThreadKeys } from "./useBotThreadKeys";
import "../../index.css";

const SHOW_BOT_THREADS_KEY = "goat:sidebar:show-bot-threads";
const local = EnvironmentId.make("environment-local");
const shells = vi.hoisted(() => ({ threads: [] as ReadonlyArray<Thread> }));

function row(id: string, via?: "thread_launch" | "delegate_task"): Thread {
  const base = makeThreadFixture({ id: ThreadId.make(id), environmentId: local, runtime: null });
  if (via === undefined) return base;
  return {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch",
        threadId: ThreadId.make("goat-bot-session:conversation"),
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via,
      },
    },
  };
}

const THREADS = [
  row("goat-bot-session:conversation"),
  row("bot-observation", "delegate_task"),
  row("bot-coding", "thread_launch"),
  row("channel-worker:work"),
];
shells.threads = THREADS;
const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(local, ThreadId.make(id)));

// The shared classifier runs over fixed shells instead of a connected environment.
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const { goatBotObservationThreadKeys } = await import("@goat/client-runtime/state/threads");
  return {
    environmentThreadShells: {
      goatBotObservationThreadKeysAtom: Atom.make(() =>
        goatBotObservationThreadKeys({ threads: shells.threads }),
      ),
    },
  };
});
// The production row also subscribes to server permissions unrelated to a device preference.
vi.mock("../settings/settingsLayout", () => ({
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  ),
}));

function SidebarRows() {
  const { hidden } = useBotThreadKeys();
  const { launchFold } = partitionSidebarThreads({
    threads: THREADS,
    scopedProjectKeys: null,
    serverConfigs: new Map(),
    optimisticDrop: null,
    workingShelfEnabled: false,
    clockKey: "",
    globalAgentRef: null,
    goatBotRef: null,
    attentionByOwnerKey: new Map(),
    openSubagentOwnerKey: undefined,
    localLastVisitedAtByKey: {},
    priorityHolds: new Map(),
    acknowledgedWakes: new Set(),
    priorityReleases: new Set(),
    hiddenBotThreadKeys: hidden,
  });
  const folded = launchFold.parentKeyByKey.get(keyOf("bot-coding"));
  return (
    <ul aria-label="Sidebar threads" data-coding-folds-under={folded ?? "none"}>
      {launchFold.roots
        .map((thread) => String(thread.id))
        .toSorted()
        .map((id) => (
          <li key={id}>{id}</li>
        ))}
    </ul>
  );
}

const renderSettingsAndSidebar = () =>
  render(
    <RegistryProvider>
      <ShowBotThreadsSetting />
      <SidebarRows />
    </RegistryProvider>,
  );

function withoutStoredChoice() {
  const saved = localStorage.getItem(SHOW_BOT_THREADS_KEY);
  localStorage.removeItem(SHOW_BOT_THREADS_KEY);
  return {
    [Symbol.dispose]: () =>
      saved === null
        ? localStorage.removeItem(SHOW_BOT_THREADS_KEY)
        : localStorage.setItem(SHOW_BOT_THREADS_KEY, saved),
  };
}

const HIDDEN = ["bot-coding", "channel-worker:work"];
const SHOWN = ["bot-observation", "channel-worker:work", "goat-bot-session:conversation"];

async function expectRows(ids: ReadonlyArray<string>) {
  await vi.waitFor(() =>
    expect(
      page
        .getByRole("listitem")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(ids),
  );
}

it("lists GOAT Bot threads only while the Settings switch is on, with today's folding", async () => {
  using _choice = withoutStoredChoice();
  await using _screen = await renderSettingsAndSidebar();
  const reveal = page.getByRole("switch", { name: "Show GOAT Bot threads" });
  await expect.element(reveal).not.toBeChecked();
  await expectRows(HIDDEN);

  await userEvent.click(reveal);
  await expectRows(SHOWN);
  await expect
    .element(page.getByRole("list", { name: "Sidebar threads" }))
    .toHaveAttribute("data-coding-folds-under", keyOf("goat-bot-session:conversation"));
  expect(localStorage.getItem(SHOW_BOT_THREADS_KEY)).toBe("true");

  await userEvent.click(reveal);
  await expectRows(HIDDEN);
  expect(localStorage.getItem(SHOW_BOT_THREADS_KEY)).toBe("false");
});

it("keeps the choice made in Settings after Settings and the sidebar mount again", async () => {
  using _choice = withoutStoredChoice();
  {
    await using _first = await renderSettingsAndSidebar();
    await userEvent.click(page.getByRole("switch", { name: "Show GOAT Bot threads" }));
    await expectRows(SHOWN);
  }
  await using _second = await renderSettingsAndSidebar();
  await expect.element(page.getByRole("switch", { name: "Show GOAT Bot threads" })).toBeChecked();
  await expectRows(SHOWN);
  await expect
    .element(page.getByRole("list", { name: "Sidebar threads" }))
    .toHaveAttribute("data-coding-folds-under", keyOf("goat-bot-session:conversation"));
});
