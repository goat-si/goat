import "../../index.css";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  ProviderInstanceId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  dropPolicy: false,
  upsert: vi.fn(),
  toast: vi.fn(),
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (value: unknown) => value,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [project()]) as never,
  useThreadShell: (() => ({ title: "Synthetic thread" })) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { tasks: state.tasks }, error: null })) as never,
  formatEnvironmentQueryError: () => "Unavailable",
}));
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: () => true },
    scheduledTasksLive: () => ({}),
    providersValueAtom: () => providers(),
    setScheduledTaskEnabled: { permissionAtom: () => true },
    deleteScheduledTask: { permissionAtom: () => true },
    runScheduledTaskNow: { permissionAtom: () => true },
  } as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: () => state.upsert,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => environment()) as never,
  usePrimaryEnvironmentId: () => environmentId,
  useEnvironment: (() => environment()) as never,
  useEnvironments: (() => ({ environments: [environment()] })) as never,
  useEnvironmentHttpBaseUrl: () => "https://example.test",
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_SERVER_SETTINGS) as never,
  usePrimarySettingsAvailable: () => true,
}));
vi.mock(import("../../cloud/primaryCloudLinkState"), async (original) => ({
  ...(await original()),
  usePrimaryCloudLinkState: (() => ({})) as never,
}));
vi.mock(import("../chat/ProviderModelPicker"), () => ({
  ProviderModelPicker: (() => <div />) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: [environmentId] },
    environments: [environment()],
    connectedEnvironments: [environment()],
    environment: environment(),
  })) as never,
}));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
  stackedThreadToast: ((value: unknown) => value) as never,
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
function project() {
  return {
    id: projectId,
    environmentId,
    title: "Synthetic",
    workspaceRoot: "/synthetic",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    scripts: [],
  };
}
function providers() {
  return [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "model", name: "Model", isDefault: true, isCustom: false, capabilities: null },
      ],
    },
  ];
}
function environment() {
  return {
    environmentId,
    label: "Synthetic",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: "darwin" },
      settings: DEFAULT_SERVER_SETTINGS,
      providers: providers(),
    },
  };
}
function setup(policy = "all_runs", bound = true) {
  state.dropPolicy = false;
  state.toast.mockReset();
  state.upsert.mockReset();
  const task: ScheduledTask = {
    id: ScheduledTaskId.make("task"),
    title: "Synthetic task",
    prompt: "Synthetic prompt",
    enabled: false,
    notificationPolicy: policy,
    schedule: { type: "interval", everyMs: 60000 },
    projectId,
    threadId: bound ? ThreadId.make("bound") : null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  state.tasks = [task];
  state.upsert.mockImplementation(async ({ input }: { input: ScheduledTaskUpsertInput }) => {
    const saved: ScheduledTask = {
      ...task,
      title: input.title,
      prompt: input.prompt,
      threadId: input.threadId ?? null,
      ...(input.notificationPolicy === undefined
        ? {}
        : { notificationPolicy: input.notificationPolicy }),
    };
    const { notificationPolicy: _omitted, ...withoutPolicy } = saved;
    const returned = state.dropPolicy ? withoutPolicy : saved;
    state.tasks = [returned];
    return { _tag: "Success", value: { task: returned } };
  });
  return task;
}

it("visibly resets an important policy when unbinding and retains it on editor reopen", async () => {
  const task = setup("important_updates");
  await using screen = await render(
    <ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />,
  );
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Run in new threads" }));
  await expect
    .element(
      page.getByText(
        "Notifications changed to All runs because Important updates requires an existing thread.",
      ),
    )
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save task" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.tasks[0]?.threadId).toBeNull();
  expect(state.tasks[0]?.notificationPolicy).toBe("all_runs");
  await screen.rerender(
    <ScheduledTasksSettings key="reopened" environmentId={environmentId} taskId={task.id} />,
  );
  await expect
    .element(page.getByRole("combobox", { name: "Notifications" }))
    .toHaveTextContent("All runs");
});

it("keeps the editor open when an older host drops the requested policy", async () => {
  const task = setup();
  state.dropPolicy = true;
  await using _screen = await render(
    <ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />,
  );
  await userEvent.click(page.getByRole("combobox", { name: "Notifications" }));
  await userEvent.click(page.getByRole("option", { name: "Failed runs only" }));
  await userEvent.click(page.getByRole("button", { name: "Save task" }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Unsupported environment" }),
  );
});

it("preserves a future policy on an unrelated save", async () => {
  const task = setup("future-policy");
  await using _screen = await render(
    <ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />,
  );
  await expect
    .element(page.getByRole("combobox", { name: "Notifications" }))
    .toHaveTextContent("Unsupported policy (kept)");
  await userEvent.click(page.getByRole("button", { name: "Save task" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.tasks[0]?.notificationPolicy).toBe("future-policy");
});

it("offers Important updates only for tasks posting into an existing thread", async () => {
  const task = setup("all_runs", false);
  await using _screen = await render(
    <ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />,
  );
  await userEvent.click(page.getByRole("combobox", { name: "Notifications" }));
  await expect
    .element(page.getByRole("option", { name: "Important updates" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Failed runs only" }));
  await userEvent.click(page.getByRole("button", { name: "Save task" }));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.tasks[0]?.notificationPolicy).toBe("failed_runs_only");
});
