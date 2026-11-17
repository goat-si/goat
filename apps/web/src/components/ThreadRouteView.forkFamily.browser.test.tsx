import { scopeThreadRef } from "@goat/client-runtime/environment";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@goat/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

// What the client holds: a fork's shell names its source; an older settled source is outside the
// shell window, so it has no shell until the fork's family read brings it.
const held = vi.hoisted(() => ({
  shells: new Map<string, unknown>(),
  mounted: [] as Array<string>,
  released: [] as Array<string>,
}));

vi.mock("../state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/threads")>()),
  threadFamilies: {
    mount: (_registry: unknown, _environmentId: string, threadId: string) => {
      held.mounted.push(threadId);
      return () => held.released.push(threadId);
    },
  },
  useEnvironmentThread: () => EMPTY_ENVIRONMENT_THREAD_STATE,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useEnvironmentThreadRefs: () => [],
  useThreadRefs: () => [],
  useQuietThreadShell: (ref: { threadId: string } | null) =>
    (ref && held.shells.get(ref.threadId)) ?? null,
}));
vi.mock("../state/presentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/presentation")>()),
  useEnvironmentShellSync: () => "live",
}));
vi.mock("../state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/shell")>()),
  useEnvironmentShellStatus: () => "live",
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomRefresh: () => () => undefined,
}));
vi.mock("./ChatView", () => ({ default: () => <div>chat view</div> }));
vi.mock("./goatBot/goatBotMemberThread", () => ({
  useGoatBotMemberAt: () => ({ member: null, pending: false, unavailable: false, retry: () => {} }),
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { ThreadRouteView } from "./ThreadRouteView";

const environmentId = EnvironmentId.make("env");
const SOURCE = ThreadId.make("older-settled-source");
const FORK = ThreadId.make("fresh-fork");
const shell = (id: ThreadId, forkedFrom: unknown = null) => ({
  id,
  environmentId,
  deletedAt: null,
  archivedAt: null,
  forkedFrom,
});

function setup(shells: ReadonlyArray<ReturnType<typeof shell>>) {
  held.shells = new Map(shells.map((entry) => [entry.id, entry]));
  held.mounted = [];
  held.released = [];
}

const route = (threadId: ThreadId) => (
  <ThreadRouteView
    target={{ kind: "server", threadRef: scopeThreadRef(environmentId, threadId) }}
  />
);

it("reads the family of a fork whose source the client does not hold, until the route leaves it", async () => {
  // Twenty-five newer settled threads fill the shell window, so the source's shell is not sent.
  const newer = Array.from({ length: 25 }, (_, index) => shell(ThreadId.make(`settled-${index}`)));
  setup([...newer, shell(FORK, { type: "run", threadId: SOURCE, runId: "run-1" })]);
  await using screen = await render(route(FORK));
  await expect.element(screen.getByText("chat view")).toBeVisible();

  expect(held.mounted).toEqual([FORK]);
  // The read brings the source; the mount stays while the fork is open.
  held.shells.set(SOURCE, shell(SOURCE));
  await screen.rerender(route(FORK));
  await expect.element(screen.getByText("chat view")).toBeVisible();
  expect(held.released).toEqual([]);
  await screen.rerender(route(newer[0]!.id));
  await expect.element(screen.getByText("chat view")).toBeVisible();
  expect(held.released).toEqual([FORK]);
  expect(held.mounted).toEqual([FORK]);
});

it("reads nothing for a fork whose source the client holds, or for a thread that is not a fork", async () => {
  setup([shell(SOURCE), shell(FORK, { type: "run", threadId: SOURCE, runId: "run-1" })]);
  await using screen = await render(route(FORK));
  await expect.element(screen.getByText("chat view")).toBeVisible();
  await screen.rerender(route(SOURCE));
  await expect.element(screen.getByText("chat view")).toBeVisible();

  expect(held.mounted).toEqual([]);
});
