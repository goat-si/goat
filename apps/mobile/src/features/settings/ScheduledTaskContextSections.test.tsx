import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({
    title,
    footer,
    children,
  }: {
    title: string;
    footer?: string;
    children?: ReactNode;
  }) => (
    <section aria-label={title}>
      {children}
      {footer ? <p>{footer}</p> : null}
    </section>
  ),
}));
vi.mock("./ScheduledTaskFormFields", () => ({
  SelectRow: ({
    label,
    value,
    actions = [],
    onSelect,
  }: {
    label: string;
    value: string;
    actions?: ReadonlyArray<{ id: string; title: string }>;
    onSelect?: (id: string) => void;
  }) => (
    <>
      <button type="button" aria-label={`${label}, ${value}`} />
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-label={`${label}: ${action.title}`}
          onClick={() => onSelect?.(action.id)}
        />
      ))}
    </>
  ),
  FormField: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock("../../lib/modelOptions", () => ({ buildModelOptions: () => [] }));

import { ScheduledTaskContextSections } from "./ScheduledTaskContextSections";
import { ScheduledTaskNotificationPolicySection } from "./ScheduledTaskNotificationPolicySection";
import { editDraft, type ScheduledTaskDraft } from "./scheduledTaskDraft";

const task = (goatBotRoutine: boolean): ScheduledTask => ({
  id: ScheduledTaskId.make("goat-bot-check-in:bot"),
  title: "Check in",
  prompt: "Look over my GOAT Bot tasks.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("replay"), model: "write-approval" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...(goatBotRoutine ? { goatBotRoutine: true } : {}),
});

async function renderSections(goatBotRoutine: boolean) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ScheduledTaskContextSections
        draft={editDraft(task(goatBotRoutine))}
        setDraft={vi.fn()}
        config={null}
        projects={[]}
        saving={false}
        locked={false}
        onPickModel={vi.fn()}
        onPickBranch={vi.fn()}
      />,
    );
  });
  const labels = [...container.querySelectorAll("[aria-label]")].map((node) =>
    node.getAttribute("aria-label"),
  );
  const text = container.textContent ?? "";
  act(() => root.unmount());
  return { labels, text };
}

it("a GOAT Bot routine shows GOAT Bot's model and no project, model or workspace choice", async () => {
  const { labels, text } = await renderSections(true);
  expect(text).toContain("GOAT Bot's model");
  expect(text).toContain("a model chosen here would not be used");
  expect(labels.some((label) => label?.startsWith("Project"))).toBe(false);
  expect(labels.some((label) => label?.startsWith("Model,"))).toBe(false);
  expect(labels.some((label) => label?.startsWith("Run in"))).toBe(false);
});

it("an ordinary task keeps its project, model and workspace choices", async () => {
  const { labels, text } = await renderSections(false);
  expect(text).not.toContain("GOAT Bot's model");
  expect(labels.some((label) => label?.startsWith("Project"))).toBe(true);
  expect(labels.some((label) => label?.startsWith("Model,"))).toBe(true);
  expect(labels.some((label) => label?.startsWith("Run in"))).toBe(true);
});

const RESET_NOTICE =
  "Notifications changed to All runs because Important updates requires an existing thread.";
const threadModesConfig = { environment: { capabilities: { scheduledTaskThreadModes: true } } };

const projects = [
  { id: ProjectId.make("project"), title: "Synthetic" },
  { id: ProjectId.make("other"), title: "Other" },
] as never;

/** The route screen's wiring of both sections around one draft. */
function Editor({ initial, threadModes }: { initial: ScheduledTaskDraft; threadModes: boolean }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <ScheduledTaskContextSections
        draft={draft}
        setDraft={setDraft}
        config={threadModes ? (threadModesConfig as never) : null}
        projects={projects}
        saving={false}
        locked={false}
        onPickModel={vi.fn()}
        onPickBranch={vi.fn()}
      />
      <ScheduledTaskNotificationPolicySection
        draft={draft}
        threadModes={threadModes}
        disabled={false}
        onChange={setDraft}
      />
    </>
  );
}

async function renderEditor(overrides: Partial<ScheduledTask>, threadModes = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Editor initial={editDraft({ ...task(false), ...overrides })} threadModes={threadModes} />,
    );
  });
  const press = async (label: string) => {
    const button = container.querySelector(`[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => (button as HTMLButtonElement).click());
  };
  const labels = () =>
    [...container.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label"));
  return { container, press, labels, [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("choosing Important updates again clears the reset notice", async () => {
  using editor = await renderEditor({
    threadId: ThreadId.make("bound"),
    threadMode: "continue",
    notificationPolicy: "important_updates",
  });
  await editor.press("Runs go to: New thread each run");
  expect(editor.container.textContent).toContain(RESET_NOTICE);
  await editor.press("Runs go to: One thread, same conversation");
  await editor.press("Notifications: Important updates");
  expect(editor.container.textContent).not.toContain(RESET_NOTICE);
  expect(editor.labels()).toContain("Notifications, Important updates");
});

it("New thread each run on an Important updates task shows the notice and drops the choice", async () => {
  using editor = await renderEditor({
    threadId: ThreadId.make("bound"),
    threadMode: "continue",
    notificationPolicy: "important_updates",
  });
  expect(editor.labels()).toContain("Notifications: Important updates");
  await editor.press("Runs go to: New thread each run");
  expect(editor.container.textContent).toContain(RESET_NOTICE);
  expect(editor.labels()).toContain("Notifications, All runs");
  expect(editor.labels()).not.toContain("Notifications: Important updates");
});

it("moving a bound task to another project shows the next run starting a thread there", async () => {
  using editor = await renderEditor({
    threadId: ThreadId.make("bound"),
    threadMode: "continue",
    notificationPolicy: "important_updates",
  });
  expect(editor.container.textContent).toContain("Each run continues this conversation.");
  await editor.press("Project: Other");
  expect(editor.container.textContent).toContain(RESET_NOTICE);
  expect(editor.container.textContent).toContain("The first run starts the thread.");
  expect(editor.labels()).not.toContain("Notifications: Important updates");
  await editor.press("Project: Synthetic");
  expect(editor.container.textContent).toContain("Each run continues this conversation.");
  expect(editor.labels()).toContain("Notifications: Important updates");
});

it("without thread modes, a project change keeps Important updates, as an older server keeps the thread", async () => {
  using editor = await renderEditor(
    {
      threadId: ThreadId.make("bound"),
      threadMode: "continue",
      notificationPolicy: "important_updates",
    },
    false,
  );
  await editor.press("Project: Other");
  expect(editor.container.textContent).not.toContain(RESET_NOTICE);
  expect(editor.labels()).toContain("Notifications, Important updates");
  expect(editor.labels()).toContain("Notifications: Important updates");
});

it("coming back to the thread clears the reset notice and keeps All runs", async () => {
  using editor = await renderEditor({
    threadId: ThreadId.make("bound"),
    threadMode: "continue",
    notificationPolicy: "important_updates",
  });
  await editor.press("Runs go to: New thread each run");
  expect(editor.container.textContent).toContain(RESET_NOTICE);
  await editor.press("Runs go to: One thread, same conversation");
  expect(editor.container.textContent).not.toContain(RESET_NOTICE);
  expect(editor.labels()).toContain("Notifications, All runs");
  await editor.press("Notifications: Important updates");
  await editor.press("Project: Other");
  expect(editor.container.textContent).toContain(RESET_NOTICE);
  await editor.press("Project: Synthetic");
  expect(editor.container.textContent).not.toContain(RESET_NOTICE);
  expect(editor.labels()).toContain("Notifications, All runs");
});
