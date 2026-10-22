import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => <div>Work card</div> }));

import { GoatBotTimeline } from "./GoatBotTimeline";

let root: Root;
let container: HTMLDivElement;
const createdAt = "2026-10-12T09:40:00Z";
const user = (
  id: string,
  sendKey: string | null = null,
  requestKey: string | null = null,
): GoatBotRow => ({
  kind: "user",
  sendKey,
  requestKey,
  id,
  text: id,
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "sending" },
  showReceipt: false,
});
const bot: GoatBotRow = {
  kind: "bot",
  id: "bot",
  text: "Reply",
  createdAt,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};
const task: GoatBotRow = {
  kind: "task",
  id: "task",
  createdAt,
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task",
    revision: 1,
    updatedAt: createdAt,
    title: "Work",
    statusLabel: "Running",
    tone: "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "none", label: "Unavailable" },
  },
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("plays the send motion once on the element that survives the acknowledgement", async () => {
  await act(() => root.render(<GoatBotTimeline rows={[bot, task]} onRetry={() => {}} />));
  expect(container.querySelector("li.goat-arrive")).toBeNull();

  await act(() =>
    root.render(
      <GoatBotTimeline rows={[bot, task, user("pending:a", "a", null)]} onRetry={() => {}} />,
    ),
  );
  const animated = container.querySelector("li.goat-arrive");
  expect(animated?.textContent).toContain("pending:a");

  // The server accepts the send, then its own row replaces the pending row with the same input id.
  await act(() =>
    root.render(
      <GoatBotTimeline rows={[bot, task, user("pending:a", "a", "input-1")]} onRetry={() => {}} />,
    ),
  );
  expect(container.querySelector("li.goat-arrive")).toBe(animated);
  await act(() =>
    root.render(
      <GoatBotTimeline rows={[bot, task, user("item-1", null, "input-1")]} onRetry={() => {}} />,
    ),
  );
  expect(container.querySelector("li.goat-arrive")).toBe(animated);
  expect(container.querySelectorAll("li.goat-arrive")).toHaveLength(1);
});

it("does not animate committed history, bot replies or task cards on mount", async () => {
  await act(() =>
    root.render(
      <GoatBotTimeline
        rows={[user("item-1", null, "input-1"), user("item-2"), bot, task]}
        onRetry={() => {}}
      />,
    ),
  );
  expect(container.querySelector("li.goat-arrive")).toBeNull();
});
