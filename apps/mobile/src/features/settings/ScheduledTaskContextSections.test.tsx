import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
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
  SettingsSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("./ScheduledTaskFormFields", () => ({
  SelectRow: ({ label, value }: { label: string; value: string }) => (
    <button type="button" aria-label={`${label}, ${value}`} />
  ),
  FormField: ({ label }: { label: string }) => <input aria-label={label} />,
}));
vi.mock("../../lib/modelOptions", () => ({ buildModelOptions: () => [] }));

import { ScheduledTaskContextSections } from "./ScheduledTaskContextSections";
import { editDraft } from "./scheduledTaskDraft";

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
