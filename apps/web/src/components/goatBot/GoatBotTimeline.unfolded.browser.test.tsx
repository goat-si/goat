import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";

vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

it("failing-first: a choice with an attachment stays at its visible sent row", async () => {
  const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const question: Extract<GoatBotRow, { kind: "bot" }> = {
    kind: "bot",
    id: "question",
    text: "Which option?",
    tone: "question",
    proactive: false,
    replyTo: null,
    options: ["Keep", "Change"],
    choices: ["Keep", "Change"],
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
  };
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (
    shown: ReadonlyArray<GoatBotRow>,
    submissions: Array<{ key: string; text: string; questionRowId: string | null }>,
  ) => <GoatBotTimeline rows={shown} onRetry={() => {}} {...{ submissions }} />;
  const before = [...messages.slice(0, 10), question, ...messages.slice(10)];
  await using screen = await render(view(before, []), { container: host, router: false }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const sent: GoatBotRow = {
    ...(messages[0] as Extract<GoatBotRow, { kind: "user" }>),
    id: "pending:with-file",
    sendKey: "with-file",
    text: "Keep",
    attachments: [{ id: "file", type: "file", name: "note.txt" }],
    delivery: { state: "sending" },
  };
  const answered = { ...question, options: [], answer: "Keep" };
  await screen.rerender(
    view(
      [...messages.slice(0, 10), answered, ...messages.slice(10), sent],
      [{ key: "with-file", text: "Keep", questionRowId: "question" }],
    ),
  );
  expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBeLessThanOrEqual(1);
});

it.each([false, true])(
  "a task cue focuses the task first, with later reply: %s",
  async (laterReply) => {
    const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "user",
      id: `m-${index}`,
      sendKey: null,
      requestKey: null,
      text: `Message ${index}`,
      createdAt: "2026-10-12T09:40:00Z",
      firstInGroup: true,
      groupPosition: "single",
      delivery: { state: "delivered" },
      showReceipt: false,
    }));
    const task: GoatBotRow = {
      kind: "task",
      id: "new-task",
      createdAt: "2026-10-12T09:41:00Z",
      firstInGroup: true,
      groupPosition: "single",
      card: {
        key: "task",
        revision: 1,
        updatedAt: "2026-10-12T09:41:00Z",
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
    const host = document.createElement("div");
    host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
    await using screen = await render(<GoatBotTimeline rows={messages} onRetry={() => {}} />, {
      container: host,
      router: false,
    }); // The task card is mocked and has no link.
    const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
    await act(() => {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    });
    const reply: GoatBotRow = {
      kind: "bot",
      id: "reply",
      text: "Reply",
      tone: "reply",
      proactive: false,
      replyTo: null,
      options: [],
      createdAt: "2026-10-12T09:42:00Z",
      firstInGroup: true,
      groupPosition: "single",
    };
    await screen.rerender(
      <GoatBotTimeline
        rows={[...messages, task, ...(laterReply ? [reply] : [])]}
        onRetry={() => {}}
      />,
    );
    const jump = [...screen.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Jump to latest"),
    );
    expect(jump).toBeDefined();
    await act(() => jump!.click());
    const taskRow = screen.container.querySelector<HTMLElement>('[data-follow-row="new-task"]')!;
    expect(document.activeElement).toBe(taskRow);
    expect(taskRow.tabIndex).toBe(-1);
    expect(taskRow.getAttribute("aria-label")).toContain("Work");
    expect(screen.container.textContent).not.toContain("Jump to latest");
  },
);

it("removes a filtered arrival from the cue and restores the unread pill", async () => {
  const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const reply: GoatBotRow = {
    kind: "bot",
    id: "new",
    text: "Reply",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: true,
    groupPosition: "single",
  };
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (rows: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline rows={rows} onRetry={() => {}} />
  );
  await using screen = await render(view(messages), { container: host, router: false }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view([...messages, reply]));
  expect(screen.container.textContent).toContain("Jump to latest");
  await screen.rerender(view(messages));
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("failing-first: another device's matching folded answer cannot consume a local send", async () => {
  const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const question: Extract<GoatBotRow, { kind: "bot" }> = {
    kind: "bot",
    id: "question",
    text: "Which option?",
    tone: "question",
    proactive: false,
    replyTo: null,
    options: ["Keep"],
    choices: ["Keep"],
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
  };
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (
    row: GoatBotRow,
    submissions: Array<{ key: string; text: string; questionRowId: string | null }>,
  ) => (
    <GoatBotTimeline
      rows={[...messages.slice(0, 10), row, ...messages.slice(10)]}
      onRetry={() => {}}
      {...{ submissions }}
    />
  );
  await using screen = await render(view(question, []), { container: host, router: false }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const remote = {
    ...question,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerInputRowId: "pending:remote",
  };
  await screen.rerender(view(remote, [{ key: "local", text: "Keep", questionRowId: "question" }]));
  expect(scroll.scrollTop).toBe(0);
  const local = { ...remote, answerInputRowId: "pending:local" };
  await screen.rerender(view(local, [{ key: "local", text: "Keep", questionRowId: "question" }]));
  const anchor = screen.container.querySelector<HTMLElement>('[data-bot-row="question"]')!;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scroll.getBoundingClientRect().bottom + 1,
  );
});

it("failing-first: warm live history cues both catch-up and later replies while reading above", async () => {
  const rows: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const reply = (id: string): GoatBotRow => ({
    kind: "bot",
    id,
    text: id,
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: true,
    groupPosition: "single",
  });
  const baselineIds = new Set(rows.map((row) => row.id));
  const view = (shown: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline
      rows={shown}
      onRetry={() => {}}
      {...{ baselineIds, sourceIds: new Set(shown.map((row) => row.id)) }}
    />
  );
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  await using screen = await render(view(rows), { container: host, router: false }); // No links in these rows.
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view([...rows, reply("catch-up")]));
  expect(screen.container.textContent).toContain("Jump to latest");
  await screen.rerender(view([...rows, reply("catch-up"), reply("fresh")]));
  expect(screen.container.textContent).toContain("Jump to latest (2 new)");
});

it("guard: an arrival first exposed while following does not become new after scrolling up", async () => {
  const rows: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const reply: GoatBotRow = {
    kind: "bot",
    id: "filtered",
    text: "Reply",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: true,
    groupPosition: "single",
  };
  const baselineIds = new Set(rows.map((row) => row.id));
  const sourceIds = new Set([...baselineIds, "filtered"]);
  const view = (shown: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline rows={shown} onRetry={() => {}} {...{ baselineIds, sourceIds }} />
  );
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  await using screen = await render(view(rows), { container: host, router: false }); // No links in these rows.
  await screen.rerender(view([...rows, reply]));
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view(rows));
  await screen.rerender(view([...rows, reply]));
  expect(screen.container.textContent).not.toContain("Jump to latest");
});
