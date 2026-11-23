import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  type AnyRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftId, restoreFailedDraftThread, useComposerDraftStore } from "../../composerDraftStore";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { resolveActiveDestination } from "./destinationRail.logic";
import { HomeRailItem } from "./DestinationRail";
import { startMainAppLocationTracking } from "./mainAppLocation";

const data = vi.hoisted(() => ({
  shells: new Map<string, { archivedAt: string | null; deletedAt: string | null }>(),
  environmentIds: [] as string[],
}));

vi.mock("~/state/entities", async (original) => {
  const shellOf = (ref: { environmentId: string; threadId: string } | null) =>
    ref === null ? null : (data.shells.get(`${ref.environmentId}/${ref.threadId}`) ?? null);
  return {
    ...(await original<typeof import("~/state/entities")>()),
    useThreadShell: shellOf,
    useQuietThreadShell: shellOf,
  };
});
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironments: () => ({
    isReady: true,
    environments: data.environmentIds.map((environmentId) => ({ environmentId })),
  }),
}));

// Persisted under this key; changing it forgets every person's Home thread.
const STORAGE_KEY = "goat:home-return-thread:v1";
const ENV = EnvironmentId.make("env-1");
const OTHER_ENV = EnvironmentId.make("env-2");
const LIVE = { archivedAt: null, deletedAt: null };
const PROJECT = scopeProjectRef(ENV, ProjectId.make("project-1"));
const OTHER_PROJECT = scopeProjectRef(ENV, ProjectId.make("project-2"));

function setup(threads: ReadonlyArray<string> = []) {
  localStorage.removeItem(STORAGE_KEY);
  data.environmentIds = [ENV, OTHER_ENV];
  data.shells = new Map(threads.map((threadId) => [`${ENV}/${threadId}`, LIVE]));
  const drafts = useComposerDraftStore.getState();
  const agent = useGlobalAgentStore.getState();
  return {
    [Symbol.dispose]: () => {
      useComposerDraftStore.setState(drafts, true);
      useGlobalAgentStore.setState(agent, true);
      localStorage.removeItem(STORAGE_KEY);
    },
  };
}

function Shell() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <>
      <HomeRailItem active={resolveActiveDestination(pathname, { isBotRoute: false }) === "home"} />
      <Outlet />
    </>
  );
}

function ThreadPage() {
  const { threadId } = useParams({ strict: false });
  return <h1>Thread {threadId}</h1>;
}

function DraftPage() {
  const { draftId } = useParams({ strict: false });
  return <h1>Draft {draftId}</h1>;
}

function createAppRouter(path: string): AnyRouter {
  const root = createRootRoute({ component: Shell });
  const page = (routePath: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => root, path: routePath, component });
  return createRouter({
    routeTree: root.addChildren([
      page("/", () => <h1>Home landing</h1>),
      page("/$environmentId/$threadId", ThreadPage),
      page("/draft/$draftId", DraftPage),
      page("/fleet", () => <h1>Fleet</h1>),
      page("/usage", () => <h1>Usage</h1>),
      page("/settings/general", () => <h1>Settings</h1>),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    disableGlobalCatchBoundary: true,
  });
}

/** Opens the app shell at `path` with location tracking started, as appInit does. */
async function openApp(path: string) {
  const router = createAppRouter(path);
  await using stack = new AsyncDisposableStack();
  // The shared test router has a single route without params; the rail reads real route params.
  const screen = stack.use(await render(<RouterProvider router={router} />, { router: false }));
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
  stack.defer(startMainAppLocationTracking(router));
  const owned = stack.move();
  return {
    router,
    home: () => screen.getByRole("link", { name: "Home" }),
    heading: (name: string) => screen.getByRole("heading", { name }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

async function go(router: AnyRouter, href: string) {
  await router.navigate({ href });
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

it("Home returns to the last thread after other destinations and GOAT Bot threads", async () => {
  using _data = setup(["thread-a", "thread-b", "legacy-bot"]);
  useGlobalAgentStore.setState({
    botRef: {
      environmentId: ENV,
      projectId: ProjectId.make("bot"),
      threadId: ThreadId.make("legacy-bot"),
    },
  });
  await using app = await openApp(`/${ENV}/thread-a`);

  await go(app.router, `/${ENV}/thread-b`);
  for (const href of [
    "/fleet",
    `/${ENV}/channel-member-bot:scout`,
    `/${ENV}/goat-bot-session:one`,
    `/${ENV}/legacy-bot`,
    "/usage",
    "/settings/general",
    "/",
  ]) {
    await go(app.router, href);
  }
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-b")).toBeVisible();
  await expect.element(app.home()).toHaveAttribute("aria-current", "page");
});

it("Home is not the current page on a member bot's thread", async () => {
  using _data = setup(["thread-a"]);
  await using app = await openApp(`/${ENV}/channel-member-bot:scout`);

  await expect.element(app.home()).not.toHaveAttribute("aria-current");
});

it("a main bot thread GOAT identifies only after it opened does not replace Home", async () => {
  using _data = setup(["thread-a", "legacy-bot"]);
  useGlobalAgentStore.setState({ botRef: null });
  await using app = await openApp(`/${ENV}/thread-a`);

  await go(app.router, `/${ENV}/legacy-bot`);
  useGlobalAgentStore.setState({
    botRef: {
      environmentId: ENV,
      projectId: ProjectId.make("bot"),
      threadId: ThreadId.make("legacy-bot"),
    },
  });
  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-a")).toBeVisible();
});

it("a draft whose send fails stays Home's target", async () => {
  using _data = setup();
  const draftId = DraftId.make("draft-1");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(PROJECT, draftId, { threadId: ThreadId.make("reserved-1") });
  const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
  await using app = await openApp("/draft/draft-1");

  await go(app.router, "/fleet");
  useComposerDraftStore
    .getState()
    .markDraftThreadPromoting(draftId, scopeThreadRef(ENV, ThreadId.make("reserved-1")));
  restoreFailedDraftThread(draftId, draft, ThreadId.make("reserved-1"));
  await userEvent.click(app.home());

  await expect.element(app.heading("Draft draft-1")).toBeVisible();
});

it("a draft sent while a late-identified bot thread is open stays Home's target", async () => {
  using _data = setup(["legacy-bot"]);
  useGlobalAgentStore.setState({ botRef: null });
  const draftId = DraftId.make("draft-1");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(PROJECT, draftId, { threadId: ThreadId.make("reserved-1") });
  await using app = await openApp("/draft/draft-1");

  await go(app.router, `/${ENV}/legacy-bot`);
  data.shells.set(`${ENV}/sent-1`, LIVE);
  const drafts = useComposerDraftStore.getState();
  drafts.markDraftThreadPromoting(draftId, scopeThreadRef(ENV, ThreadId.make("sent-1")));
  useComposerDraftStore.getState().finalizePromotedDraftThread(draftId);
  useGlobalAgentStore.setState({
    botRef: {
      environmentId: ENV,
      projectId: ProjectId.make("bot"),
      threadId: ThreadId.make("legacy-bot"),
    },
  });
  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread sent-1")).toBeVisible();
});

it("a thread with the bot's id on another machine is an ordinary thread", async () => {
  using _data = setup();
  data.shells.set(`${OTHER_ENV}/legacy-bot`, LIVE);
  useGlobalAgentStore.setState({
    botRef: {
      environmentId: ENV,
      projectId: ProjectId.make("bot"),
      threadId: ThreadId.make("legacy-bot"),
    },
  });
  await using app = await openApp(`/${OTHER_ENV}/legacy-bot`);

  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread legacy-bot")).toBeVisible();
  expect(app.router.state.location.pathname).toBe(`/${OTHER_ENV}/legacy-bot`);
});

it("Home on the open thread keeps the thread, its view and its history", async () => {
  using _data = setup(["thread-a"]);
  await using app = await openApp(`/${ENV}/thread-a?view=diff`);
  const before = app.router.state.location;

  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-a")).toBeVisible();
  expect(app.router.state.location.href).toBe(before.href);
  expect(app.router.state.location.state.__TSR_index).toBe(before.state.__TSR_index);
});

it.each([
  [
    "archived",
    () => data.shells.set(`${ENV}/thread-a`, { ...LIVE, archivedAt: "2026-11-23T00:00:00.000Z" }),
  ],
  [
    "deleted",
    () => data.shells.set(`${ENV}/thread-a`, { ...LIVE, deletedAt: "2026-11-23T00:00:00.000Z" }),
  ],
  ["on a removed machine", () => (data.environmentIds = [OTHER_ENV])],
])("Home opens the landing page when the last thread is %s", async (_case, invalidate) => {
  using _data = setup(["thread-a"]);
  await using app = await openApp(`/${ENV}/thread-a`);

  invalidate();
  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Home landing")).toBeVisible();
});

it("Home opens a thread the sidebar no longer lists, leaving it to the thread page", async () => {
  using _data = setup(["thread-old"]);
  await using app = await openApp(`/${ENV}/thread-old`);

  await go(app.router, "/fleet");
  data.shells.clear();
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-old")).toBeVisible();
});

it.each([
  ["on first run", () => {}],
  [
    "over an unreadable record",
    () => localStorage.setItem(STORAGE_KEY, '{"kind":"server","environmentId":""}'),
  ],
])("Home opens the landing page %s", async (_case, arrange) => {
  using _data = setup(["thread-a"]);
  arrange();
  await using app = await openApp("/fleet");

  await userEvent.click(app.home());

  await expect.element(app.heading("Home landing")).toBeVisible();
});

it("Home reopens a draft, follows it once sent, and lets go once it is discarded", async () => {
  using _data = setup();
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(PROJECT, DraftId.make("draft-1"), {
    threadId: ThreadId.make("reserved-1"),
  });
  // A project holds one draft.
  drafts.setProjectDraftThreadId(OTHER_PROJECT, DraftId.make("draft-2"), {
    threadId: ThreadId.make("reserved-2"),
  });
  await using app = await openApp("/draft/draft-1");

  await go(app.router, "/fleet");
  await userEvent.click(app.home());
  await expect.element(app.heading("Draft draft-1")).toBeVisible();

  // Sent while away: its thread can differ from the reserved id, and finalizing drops the draft.
  await go(app.router, "/fleet");
  const sentRef = scopeThreadRef(ENV, ThreadId.make("sent-1"));
  data.shells.set(`${ENV}/sent-1`, LIVE);
  useComposerDraftStore.getState().markDraftThreadPromoting(DraftId.make("draft-1"), sentRef);
  useComposerDraftStore.getState().finalizePromotedDraftThread(DraftId.make("draft-1"));
  await userEvent.click(app.home());
  await expect.element(app.heading("Thread sent-1")).toBeVisible();

  await go(app.router, "/draft/draft-2");
  await go(app.router, "/fleet");
  useComposerDraftStore.getState().clearDraftThread(DraftId.make("draft-2"));
  await userEvent.click(app.home());
  await expect.element(app.heading("Home landing")).toBeVisible();
});

it("Home does not reopen a draft on a removed machine", async () => {
  using _data = setup();
  useComposerDraftStore.getState().setProjectDraftThreadId(PROJECT, DraftId.make("draft-1"), {
    threadId: ThreadId.make("reserved-1"),
  });
  await using app = await openApp("/draft/draft-1");

  data.environmentIds = [OTHER_ENV];
  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Home landing")).toBeVisible();
});

it("the last Home thread survives a restart", async () => {
  using _data = setup(["thread-a"]);
  {
    await using first = await openApp(`/${ENV}/thread-a`);
    await go(first.router, "/fleet");
  }
  await using app = await openApp("/fleet");

  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-a")).toBeVisible();
});

it("Home still returns within the session when storage refuses reads and writes", async () => {
  using _data = setup(["thread-a"]);
  using _read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  using _write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  await using app = await openApp(`/${ENV}/thread-a`);

  await go(app.router, "/fleet");
  await userEvent.click(app.home());

  await expect.element(app.heading("Thread thread-a")).toBeVisible();
});
