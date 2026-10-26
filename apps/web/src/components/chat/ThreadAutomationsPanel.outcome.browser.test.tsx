import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  toggle: vi.fn(),
  run: vi.fn(),
  task: null as ScheduledTask | null,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// The panel reads the run permission through an atom; the grant is the boundary under test.
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => state.allowed) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { serverEnvironment } = await import("../../state/server");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === serverEnvironment.setScheduledTaskEnabled ? state.toggle : state.run) as never,
  };
});
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { tasks: state.task === null ? [] : [state.task] },
    error: null,
  })) as never,
}));

import { render } from "../../../test/render";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const task = {
  id: ScheduledTaskId.make("task"),
  threadId,
  title: "Daily review",
  enabled: true,
  schedule: { type: "interval", everyMs: 60000 },
  lastRunStatus: "never",
} as ScheduledTask;

function setup() {
  state.allowed = true;
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
  state.task = {
    ...task,
    lastRunStatus: "running",
    lastRun: {
      firingId: "firing",
      dispatchStatus: "accepted",
      status: "queued",
      threadId,
      runId: "run",
      requestedAt: "2026-10-15T00:00:00.000Z",
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
    },
  } as ScheduledTask;
}
it("shows queued and terminal outcomes and keeps Run now available after acceptance", async () => {
  setup();
  await using screen = await render(
    <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByText(/Queued/).first()).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Run Daily review now" })).toBeEnabled();
  state.task = { ...state.task!, lastRun: { ...state.task!.lastRun!, status: "interrupted" } };
  await screen.rerender(
    <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByText(/Interrupted/).first()).toBeVisible();
  state.task = {
    ...state.task!,
    lastRun: { ...state.task!.lastRun!, dispatchStatus: "dispatching", status: "dispatching" },
  };
  await screen.rerender(
    <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByRole("button", { name: "Run Daily review now" })).toBeDisabled();
});
