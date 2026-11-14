import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { presentTaskChip, type GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import { ChannelConversationId, ChannelTaskId, type ChannelTaskChip } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityState?: { disabled?: boolean };
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-disabled={props.accessibilityState?.disabled}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("./GoatBotLinkedText", () => ({ GoatBotLinkedText: () => null }));
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));

import { GoatBotTaskRow } from "./GoatBotTaskRow";

const card = {
  key: "task-old",
  revision: 1,
  updatedAt: "2026-11-11T02:00:00.000Z",
  title: "Summarize the README",
  statusLabel: "Needs your input",
  tone: "attention",
  sourceLabel: null,
  summary: null,
  attentionLabel: null,
  pullRequests: [],
  target: { kind: "none", label: "No thread" },
} as GoatBotTaskCard;

it("a closed row says it is disabled to assistive technology and opens nothing", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onOpenTask = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <GoatBotTaskRow card={card} onSelectThread={vi.fn()} onOpenTask={onOpenTask} disabled />,
    ),
  );
  const row = container.querySelector("button");
  expect(row?.getAttribute("aria-disabled")).toBe("true");
  expect(row?.hasAttribute("disabled")).toBe(true);
  await act(async () => row?.click());
  expect(onOpenTask).not.toHaveBeenCalled();
  await act(async () =>
    root.render(<GoatBotTaskRow card={card} onSelectThread={vi.fn()} onOpenTask={onOpenTask} />),
  );
  expect(container.querySelector("button")?.getAttribute("aria-disabled")).toBe("false");
  await act(async () => container.querySelector("button")?.click());
  expect(onOpenTask).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("without its status, a row still names the work and opens its thread", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onSelectThread = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const thread = { ...card, target: { kind: "thread", environmentId: "env", threadId: "t-1" } };
  await act(async () =>
    root.render(
      <GoatBotTaskRow
        card={thread as GoatBotTaskCard}
        onSelectThread={onSelectThread}
        statusHidden
      />,
    ),
  );
  const row = container.querySelector("button");
  expect(row?.textContent).toContain("Summarize the README");
  expect(row?.textContent).not.toContain("Needs your input");
  expect(row?.getAttribute("aria-label")).not.toContain("Needs your input");
  await act(async () => row?.click());
  expect(onSelectThread).toHaveBeenCalledWith({ environmentId: "env", id: "t-1" });
  await act(async () => root.unmount());
});

// The shared reader decides the attention line; this pins what both kinds of row show and say.
it("shows and says what waits on a person first, and no missing-report line under a written result", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const finished = (extra: Partial<ChannelTaskChip>) =>
    presentTaskChip({
      taskId: ChannelTaskId.make("task-1"),
      conversationId: ChannelConversationId.make("conv-1"),
      taskVersion: 3,
      title: "Summarize the README",
      status: "completed",
      completionReport: "missing",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: "2026-11-11T02:00:00.000Z",
      updatedAt: "2026-11-11T02:05:00.000Z",
      openQuestionCount: 0,
      ...extra,
    });
  const cases = [
    { card: finished({ summary: "I added clamp next to sum." }), status: "Done" },
    { card: finished({ summary: "Finished." }), status: "Done · Finished without a report" },
    { card: finished({ openQuestionCount: 1 }), status: "Done · 1 question" },
  ];
  const container = document.createElement("div");
  const root = createRoot(container);
  for (const { card: shown, status } of cases)
    // The result row (no onOpenTask) and a row that hides the summary, as Earlier in chat does.
    for (const onOpenTask of [undefined, vi.fn()]) {
      await act(async () =>
        root.render(
          <GoatBotTaskRow card={shown} onSelectThread={vi.fn()} onOpenTask={onOpenTask} />,
        ),
      );
      const row = container.querySelector("button");
      expect(row?.querySelector("span")?.textContent, status).toBe(status);
      expect(row?.getAttribute("aria-label"), status).toContain(`Summarize the README. ${status}.`);
    }
  await act(async () => root.unmount());
});
