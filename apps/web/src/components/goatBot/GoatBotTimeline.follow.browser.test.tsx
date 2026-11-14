import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ThreadId, type OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";

// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
const projection = vi.hoisted(() => ({
  statuses: {} as Record<string, string>,
  reads: [] as string[],
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadStatus: (ref: { threadId: string } | null) => {
    if (ref === null) return "empty";
    projection.reads.push(ref.threadId);
    return projection.statuses[ref.threadId] ?? "live";
  },
}));

import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";
import { GoatBotChatView } from "./GoatBotChatView";

const rows: ReadonlyArray<GoatBotRow> = Array.from({ length: 40 }, (_, index) => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id: `message-${index}`,
  text: `Message ${index}`,
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "delivered" },
  showReceipt: false,
}));

const scroller = (container: HTMLElement) => {
  const element = container.querySelector<HTMLElement>(".goat-timeline > div");
  if (element === null) throw new Error("expected the timeline scroller");
  return element;
};
const distanceFromBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight;

/** Runs `change` and resolves once the element's resize reached the timeline's own observer. */
async function afterResize(element: Element, change: () => Promise<void>) {
  const waiting: Array<() => void> = [];
  const next = () => new Promise<void>((resolve) => waiting.push(resolve));
  // Created after the timeline's observer, so its callback runs after the timeline's.
  const observer = new ResizeObserver(() => waiting.shift()?.());
  try {
    const observed = next();
    observer.observe(element);
    await observed;
    const resized = next();
    await change();
    await resized;
  } finally {
    observer.disconnect();
  }
}

it("stays on the newest message when a message grows after it rendered", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false, // The timeline renders no links that need a router.
  });
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // Markdown, code highlighting and images settle after the rows render.
  await act(() => {
    const last = screen.container.querySelector<HTMLElement>("li:last-child");
    if (last) last.style.paddingBottom = "300px";
  });
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  host.remove();
});

it("keeps following when a scroll event from its own move arrives after a message grew", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false, // The timeline renders no links that need a router.
  });
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // The browser delivers scroll events before resize callbacks: a late scroll event from the
  // timeline's own move to the bottom lands after the message grew, before it is followed.
  await act(() => {
    const last = screen.container.querySelector<HTMLElement>("li:last-child");
    if (last) last.style.paddingBottom = "300px";
    element.dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // Scrolling up by hand still stops the following.
  element.scrollTop = 0;
  element.dispatchEvent(new Event("scroll"));
  const list = element.querySelector("ol");
  if (list === null) throw new Error("expected the conversation list");
  await afterResize(list, () =>
    act(() => {
      const last = screen.container.querySelector<HTMLElement>("li:last-child");
      if (last) last.style.paddingBottom = "600px";
    }),
  );
  expect(element.scrollTop).toBe(0);
  host.remove();
});

it("failing-first: offers a jump when a reply arrives while reading above", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false, // This timeline has no navigation links.
  });
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const reply: GoatBotRow = {
    kind: "bot",
    id: "new-reply",
    text: "New reply",
    createdAt: "2026-10-12T09:41:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  };
  await screen.rerender(<GoatBotTimeline rows={[...rows, reply]} onRetry={() => {}} />);
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(true);
  host.remove();
});

const reply = (id: string): Extract<GoatBotRow, { kind: "bot" }> => ({
  kind: "bot",
  id,
  text: id,
  createdAt: "2026-10-12T09:41:00Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});

const question: Extract<GoatBotRow, { kind: "bot" }> = {
  ...reply("question"),
  text: "Which option?",
  tone: "question",
  options: ["Keep", "Change"],
  choices: ["Keep", "Change"],
  answerTaskId: "task-1",
  answerQuestionId: "q1",
};

function ChatFixture({ folded = false, sibling = false }: { folded?: boolean; sibling?: boolean }) {
  const [sent, setSent] = useState(false);
  const [extra, setExtra] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const initial = folded ? [...rows.slice(0, 10), question, ...rows.slice(10)] : rows;
  const sentRow: GoatBotRow = {
    ...(rows[0] as Extract<GoatBotRow, { kind: "user" }>),
    id: "pending:local-1",
    sendKey: "local-1",
    text: "hello",
    delivery: { state: "sending" },
  };
  const display = !sent
    ? initial
    : folded
      ? [
          ...rows.slice(0, 10),
          {
            ...question,
            options: [],
            answer: "Keep",
            answerIndex: 0,
            answerSending: !confirmed,
            answerInputRowId: "pending:local-1",
          },
          ...rows.slice(10),
        ]
      : [...rows, sentRow];
  return (
    <div style={{ display: "flex", height: 400, width: sibling ? 720 : 360 }}>
      <button style={{ position: "absolute" }} onClick={() => setExtra(true)}>
        Deliver remote reply
      </button>
      <button style={{ position: "absolute" }} onClick={() => setConfirmed(true)}>
        Confirm answer
      </button>
      {sibling ? (
        <div style={{ display: "flex", width: 360, height: 400 }}>
          <GoatBotTimeline rows={display} onRetry={() => {}} />
        </div>
      ) : null}
      <GoatBotChatView
        availability={{
          kind: "ready",
          bot: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("bot") },
        }}
        canOperate
        rows={extra ? [...display, reply("remote-reply")] : display}
        legacyAgentRoute={null}
        onRetryInput={() => {}}
        onSend={() => {
          setSent(true);
          return "local-1" as unknown as boolean;
        }}
        onSendToTask={() => {
          setSent(true);
          return "local-1" as unknown as boolean;
        }}
      />
    </div>
  );
}

it("failing-first: the person's composer send follows its pending row without moving focus", async () => {
  await using screen = await render(<ChatFixture />);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const field = screen.getByRole("textbox", { name: "Message GOAT Bot" });
  await userEvent.type(field, "hello{Enter}");
  expect(distanceFromBottom(element)).toBeLessThanOrEqual(1);
  expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
});

it("failing-first: a main-chat task choice follows only the initiating timeline", async () => {
  await using screen = await render(<ChatFixture folded sibling />);
  const elements = [
    ...screen.container.querySelectorAll<HTMLElement>(".goat-timeline > div:first-child"),
  ];
  expect(elements).toHaveLength(2);
  const [other, main] = elements as [HTMLElement, HTMLElement];
  await act(() => {
    other.scrollTop = 0;
    other.dispatchEvent(new Event("scroll"));
    main.scrollTop = 0;
    main.dispatchEvent(new Event("scroll"));
  });
  const cards = [...screen.container.querySelectorAll<HTMLElement>('[data-bot-row="question"]')];
  const pick = [...cards[1]!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Keep"),
  );
  expect(pick).toBeDefined();
  await act(() => pick!.click());
  expect(cards[1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    main.getBoundingClientRect().bottom + 1,
  );
  expect(other.scrollTop).toBe(0);
});

it("failing-first: a reply below a folded-answer anchor still raises the cue", async () => {
  await using screen = await render(<ChatFixture folded />);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await userEvent.type(
    screen.getByRole("textbox", { name: /Message GOAT Bot|Which option/ }),
    "Keep{Enter}",
  );
  const anchor = screen.container.querySelector<HTMLElement>('[data-bot-row="question"]')!;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  expect(distanceFromBottom(element)).toBeGreaterThan(48);
  const deliver = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Deliver remote reply",
  )!;
  await act(() => deliver.click());
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(true);
});

it("failing-first: a folded answer stays anchored across confirmation and resize until manual scroll", async () => {
  await using screen = await render(<ChatFixture folded />);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await userEvent.type(
    screen.getByRole("textbox", { name: /Message GOAT Bot|Which option/ }),
    "Keep{Enter}",
  );
  const anchor = screen.container.querySelector<HTMLElement>('[data-bot-row="question"]')!;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  const confirm = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm answer",
  )!;
  await act(() => confirm.click());
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  const list = element.querySelector("ol")!;
  const first = list.querySelector<HTMLElement>("li")!;
  await afterResize(list, () =>
    act(() => {
      first.style.paddingBottom = "100px";
    }),
  );
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await afterResize(list, () =>
    act(() => {
      first.style.paddingBottom = "200px";
    }),
  );
  expect(element.scrollTop).toBe(0);
});

it("failing-first: jump, pressed from the keyboard, focuses the first new reply and bottom scrolling clears the cue", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  await using screen = await render(<GoatBotTimeline rows={rows} onRetry={() => {}} />, {
    container: host,
    router: false,
  }); // No navigation links in these rows.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(
    <GoatBotTimeline rows={[...rows, reply("new-1"), reply("new-2")]} onRetry={() => {}} />,
  );
  const jump = screen.getByRole("button", { name: "Jump to latest (2 new)", exact: true });
  await expect.element(jump).toBeVisible();
  await act(() => jump.element().focus());
  await userEvent.keyboard("{Enter}");
  const first = screen.container.querySelector<HTMLElement>('[data-bot-row="new-1"]')!;
  expect(
    Math.abs(first.getBoundingClientRect().top - element.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(1);
  expect(document.activeElement).toBe(first);
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
  await act(() => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
});

it("failing-first: a folded composer answer follows its earlier question, not the bottom", async () => {
  await using screen = await render(<ChatFixture folded />);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const field = screen.getByRole("textbox", { name: /Message GOAT Bot|Which option/ });
  await userEvent.type(field, "Keep{Enter}");
  const anchor = screen.container.querySelector<HTMLElement>('[data-bot-row="question"]');
  expect(anchor).not.toBeNull();
  expect(anchor!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    element.getBoundingClientRect().top - 1,
  );
  expect(anchor!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  expect(distanceFromBottom(element)).toBeGreaterThan(48);
  expect(document.activeElement).toBe(screen.container.querySelector("textarea"));
});

it("guard: the same row IDs and a revised task card do not create a cue", async () => {
  const task: Extract<GoatBotRow, { kind: "task" }> = {
    kind: "task",
    id: "task",
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    card: {
      key: "task",
      revision: 1,
      updatedAt: "2026-10-12T09:40:00Z",
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
  await using screen = await render(<GoatBotTimeline rows={[...rows, task]} onRetry={() => {}} />, {
    container: host,
    router: false,
  }); // No links in the mocked card.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(
    <GoatBotTimeline
      rows={[...rows, { ...task, card: { ...task.card, revision: 2 } }]}
      onRetry={() => {}}
    />,
  );
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
});

it("failing-first: a late source baseline excludes history and exposes later filtered arrivals once", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (
    shown: ReadonlyArray<GoatBotRow>,
    baselineIds: ReadonlySet<string> | null,
    sourceIds: ReadonlySet<string>,
  ) => <GoatBotTimeline rows={shown} onRetry={() => {}} {...{ baselineIds, sourceIds }} />;
  await using screen = await render(view(rows, null, new Set()), {
    container: host,
    router: false,
  }); // No navigation links in these rows.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const history = new Set([...rows.map((row) => row.id), "hidden-history"]);
  await screen.rerender(view(rows, history, history));
  await screen.rerender(view([...rows, reply("hidden-history")], history, history));
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
  const source = new Set([...history, "new-hidden"]);
  await screen.rerender(view([...rows, reply("hidden-history")], history, source));
  await screen.rerender(
    view([...rows, reply("hidden-history"), reply("new-hidden")], history, source),
  );
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(true);
  await act(() => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view([...rows, reply("hidden-history")], history, source));
  await screen.rerender(
    view([...rows, reply("hidden-history"), reply("new-hidden")], history, source),
  );
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
});

it("guard: retrying an existing send or receiving another device's send does not move the reader", async () => {
  const pending: Extract<GoatBotRow, { kind: "user" }> = {
    ...(rows[0] as Extract<GoatBotRow, { kind: "user" }>),
    id: "pending:retry",
    sendKey: "retry",
    delivery: { state: "failed", clientKey: "retry" },
  };
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  await using screen = await render(
    <GoatBotTimeline rows={[...rows, pending]} onRetry={() => {}} />,
    { container: host, router: false },
  ); // No links in these rows.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(
    <GoatBotTimeline
      rows={[...rows, { ...pending, delivery: { state: "sending" } }]}
      onRetry={() => {}}
    />,
  );
  expect(element.scrollTop).toBe(0);
  await screen.rerender(
    <GoatBotTimeline
      rows={[
        ...rows,
        pending,
        { ...pending, id: "remote", sendKey: null, delivery: { state: "delivered" } },
      ]}
      onRetry={() => {}}
    />,
  );
  expect(element.scrollTop).toBe(0);
});

it("failing-first: an empty loaded baseline treats the first later reply as new", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const baselineIds = new Set<string>();
  const view = (shown: ReadonlyArray<GoatBotRow>, sourceIds: ReadonlySet<string>) => (
    <GoatBotTimeline rows={shown} onRetry={() => {}} {...{ baselineIds, sourceIds }} />
  );
  await using screen = await render(view([], new Set()), { container: host, router: false }); // No links in these rows.
  await screen.rerender(view(rows, new Set(rows.map((row) => row.id))));
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const next = [...rows, reply("first-reply")];
  await screen.rerender(view(next, new Set(next.map((row) => row.id))));
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(true);
});

it("failing-first: manually returning to bottom clears a cue permanently", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const view = (shown: ReadonlyArray<GoatBotRow>) => (
    <GoatBotTimeline rows={shown} onRetry={() => {}} />
  );
  await using screen = await render(view(rows), { container: host, router: false }); // No links in these rows.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const next = [...rows, reply("arrived")];
  await screen.rerender(view(next));
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(true);
  await act(() => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view(next));
  expect(
    [...screen.container.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Jump to latest"),
    ),
  ).toBe(false);
});

it("failing-first: sending after jumping keeps the sent row visible", async () => {
  await using screen = await render(<ChatFixture />);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const deliver = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Deliver remote reply",
  )!;
  await act(() => deliver.click());
  const jump = [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Jump to latest"),
  );
  expect(jump).toBeDefined();
  await act(() => jump!.click());
  await userEvent.type(screen.getByRole("textbox", { name: "Message GOAT Bot" }), "hello{Enter}");
  const sent = [...element.querySelectorAll("li")].find((row) =>
    row.textContent?.includes("hello"),
  )!;
  expect(sent.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  expect(sent.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    element.getBoundingClientRect().top - 1,
  );
});

it("failing-first: a send waits for a late folded question before anchoring", async () => {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  const pending = [{ key: "late", text: "Keep", questionRowId: null }];
  const view = (
    shown: ReadonlyArray<GoatBotRow>,
    submissions: typeof pending,
    committedSends = new Map<string, string>(),
  ) => <GoatBotTimeline rows={shown} onRetry={() => {}} {...{ submissions, committedSends }} />;
  await using screen = await render(view(rows, []), { container: host, router: false }); // No navigation links in these rows.
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view(rows, pending));
  expect(element.scrollTop).toBe(0);
  const answered = {
    ...question,
    options: [],
    answer: "Keep",
    answerIndex: 0,
    answerSending: true,
    answerInputRowId: "pending:late",
  };
  await screen.rerender(view([...rows.slice(0, 10), answered, ...rows.slice(10)], pending));
  const anchor = screen.container.querySelector<HTMLElement>('[data-bot-row="question"]')!;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  expect(distanceFromBottom(element)).toBeGreaterThan(48);
  const committed = { ...answered, answerSending: false, answerInputRowId: "committed-late" };
  const committedRows = [...rows.slice(0, 10), committed, ...rows.slice(10)];
  await screen.rerender(view(committedRows, pending, new Map([["late", "committed-late"]])));
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    element.getBoundingClientRect().bottom + 1,
  );
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(view(committedRows, pending, new Map([["late", "committed-late"]])));
  expect(element.scrollTop).toBe(0);
});

const projectedItems = (shown: ReadonlyArray<GoatBotRow>) =>
  shown.map(
    (row) =>
      ({
        item: { id: row.id, type: "assistant_message" },
      }) as unknown as OrchestrationV2ProjectedTurnItem,
  );

function SpeechChat({
  shown,
  source,
  thread = "speech",
  working = false,
}: {
  readonly shown: ReadonlyArray<GoatBotRow>;
  readonly source: ReadonlyArray<GoatBotRow>;
  readonly thread?: string;
  readonly working?: boolean;
}) {
  const environmentId = EnvironmentId.make("env");
  return (
    <GoatBotActivityContext value={working ? { state: "working", text: "Working" } : null}>
      <div style={{ display: "flex", height: 400, width: 360 }}>
        <GoatBotChatView
          projectionRef={{ environmentId, threadId: ThreadId.make(thread) }}
          visibleTurnItems={projectedItems(source)}
          environmentId={environmentId}
          availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make(thread) } }}
          canOperate
          rows={shown}
          onSend={() => true}
          onRetryInput={() => {}}
          legacyAgentRoute={null}
        />
      </div>
    </GoatBotActivityContext>
  );
}

it("guard: live history and later exposure of a hidden baseline item are silent", async () => {
  projection.statuses = { speech: "live" };
  const hidden = reply("hidden-history");
  await using screen = await render(<SpeechChat shown={rows} source={[...rows, hidden]} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  expect(status?.textContent).toBe("");
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(<SpeechChat shown={[...rows, hidden]} source={[...rows, hidden]} />);
  expect(status?.textContent).toBe("");
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("announces new bot replies once, batches the newest and keeps it through activity changes", async () => {
  projection.statuses = { speech: "live" };
  await using screen = await render(<SpeechChat shown={[]} source={[]} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  expect(status?.textContent).toBe("");
  const first = reply("first");
  await screen.rerender(<SpeechChat shown={[first]} source={[first]} />);
  expect(status?.textContent).toMatch(/GOAT Bot replied\.|New reply from GOAT Bot\./);
  const firstText = status?.textContent;
  await screen.rerender(<SpeechChat shown={[first]} source={[first]} />);
  expect(status?.textContent).toBe(firstText);
  const update = { ...reply("update"), proactive: true, tone: "status" as const };
  const question = { ...reply("question"), proactive: true, tone: "question" as const };
  await screen.rerender(
    <SpeechChat shown={[first, update, question]} source={[first, update, question]} working />,
  );
  expect(status?.textContent).toMatch(/question/);
  expect(screen.container.querySelector('[role="status"][aria-atomic="true"]')?.textContent).toBe(
    "GOAT Bot is working",
  );
  const questionText = status?.textContent;
  await screen.rerender(
    <SpeechChat shown={[first, update]} source={[first, update, question]} working />,
  );
  expect(status?.textContent).toBe(questionText);
  await screen.rerender(
    <SpeechChat shown={[first, update, question]} source={[first, update, question]} working />,
  );
  expect(status?.textContent).toBe(questionText);
  await screen.rerender(
    <SpeechChat shown={[first, update, question]} source={[first, update, question]} />,
  );
  expect(status?.textContent).toBe(questionText);
  await screen.rerender(
    <SpeechChat
      shown={[first, update, question]}
      source={[first, update, question]}
      thread="other"
    />,
  );
  expect(screen.container.querySelector("[data-goat-bot-reply-status]")?.textContent).toBe("");
});

it("announces and cues a filtered new reply only when first exposed", async () => {
  projection.statuses = { speech: "live" };
  const fresh = reply("filtered-new");
  await using screen = await render(<SpeechChat shown={rows} source={rows} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(<SpeechChat shown={rows} source={[...rows, fresh]} />);
  expect(status?.textContent).toBe("");
  expect(screen.container.textContent).not.toContain("Jump to latest");
  await screen.rerender(<SpeechChat shown={[...rows, fresh]} source={[...rows, fresh]} />);
  expect(status?.textContent).toMatch(/GOAT Bot replied\.|New reply from GOAT Bot\./);
  expect(screen.container.textContent).toContain("Jump to latest");
  const text = status?.textContent;
  await screen.rerender(<SpeechChat shown={rows} source={[...rows, fresh]} />);
  await screen.rerender(<SpeechChat shown={[...rows, fresh]} source={[...rows, fresh]} />);
  expect(status?.textContent).toBe(text);
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("consumes replies exposed during synchronization and announces only the newest on live", async () => {
  projection.statuses = { speech: "live" };
  // Distinct categories, so the wording shows which reply was announced.
  const older = { ...reply("sync-older"), proactive: true, tone: "status" as const };
  const newer = { ...reply("sync-newer"), proactive: true, tone: "question" as const };
  await using screen = await render(<SpeechChat shown={rows} source={rows} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  projection.statuses.speech = "synchronizing";
  await screen.rerender(
    <SpeechChat shown={[...rows, older, newer]} source={[...rows, older, newer]} />,
  );
  expect(status?.textContent).toBe("");
  await screen.rerender(<SpeechChat shown={[...rows, newer]} source={[...rows, older, newer]} />);
  projection.statuses.speech = "live";
  await screen.rerender(<SpeechChat shown={[...rows, newer]} source={[...rows, older, newer]} />);
  expect(status?.textContent).toBe("GOAT Bot asked a question.");
  const text = status?.textContent;
  await screen.rerender(
    <SpeechChat shown={[...rows, older, newer]} source={[...rows, older, newer]} />,
  );
  expect(status?.textContent).toBe(text);
  const ghost = reply("sync-ghost");
  projection.statuses.speech = "synchronizing";
  await screen.rerender(
    <SpeechChat shown={[...rows, ghost]} source={[...rows, older, newer, ghost]} />,
  );
  projection.statuses.other = "synchronizing";
  await screen.rerender(<SpeechChat thread="other" shown={[]} source={[]} />);
  projection.statuses.speech = "live";
  await screen.rerender(<SpeechChat shown={rows} source={[...rows, older, newer, ghost]} />);
  expect(screen.container.querySelector("[data-goat-bot-reply-status]")?.textContent).toBe("");
});

it("announces a synchronized reply even if filtering removes the last timeline row", async () => {
  projection.statuses = { speech: "live" };
  const fresh = reply("sync-last");
  await using screen = await render(<SpeechChat shown={[]} source={[]} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  projection.statuses.speech = "synchronizing";
  await screen.rerender(<SpeechChat shown={[fresh]} source={[fresh]} />);
  expect(status?.textContent).toBe("");
  await screen.rerender(<SpeechChat shown={[]} source={[fresh]} />);
  projection.statuses.speech = "live";
  await screen.rerender(<SpeechChat shown={[]} source={[fresh]} />);
  expect(status?.textContent).toMatch(/GOAT Bot replied\.|New reply from GOAT Bot\./);
});

it("announces exposure while following and never revives its cue after scrolling up", async () => {
  projection.statuses = { speech: "live" };
  const fresh = reply("following-reply");
  await using screen = await render(<SpeechChat shown={rows} source={rows} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  await screen.rerender(<SpeechChat shown={rows} source={[...rows, fresh]} />);
  await screen.rerender(<SpeechChat shown={[...rows, fresh]} source={[...rows, fresh]} />);
  expect(status?.textContent).toMatch(/GOAT Bot replied\.|New reply from GOAT Bot\./);
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await screen.rerender(<SpeechChat shown={rows} source={[...rows, fresh]} />);
  await screen.rerender(<SpeechChat shown={[...rows, fresh]} source={[...rows, fresh]} />);
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

it("announces replies after a newer send and alternates successive categories", async () => {
  projection.statuses = { speech: "live" };
  await using screen = await render(<SpeechChat shown={[]} source={[]} />);
  const status = screen.container.querySelector("[data-goat-bot-reply-status]");
  const first = reply("earlier-reply");
  const send = rows[0]!;
  await screen.rerender(<SpeechChat shown={[first, send]} source={[first, send]} />);
  expect(status?.textContent).toBe("GOAT Bot replied.");
  const update = { ...reply("an-update"), proactive: true, tone: "status" as const };
  await screen.rerender(
    <SpeechChat shown={[first, send, update]} source={[first, send, update]} />,
  );
  expect(status?.textContent).toBe("New update from GOAT Bot.");
  const question = { ...reply("a-question"), proactive: true, tone: "question" as const };
  await screen.rerender(
    <SpeechChat shown={[first, send, update, question]} source={[first, send, update, question]} />,
  );
  expect(status?.textContent).toBe("GOAT Bot asked a question.");
});

it("failing-first: the viewed thread, not the current bot, owns the live baseline", async () => {
  projection.reads = [];
  projection.statuses = { old: "empty", current: "live" };
  const environmentId = EnvironmentId.make("env");
  const ref = { environmentId, threadId: ThreadId.make("old") };
  const bot = { environmentId, threadId: ThreadId.make("current") };
  const view = (shown: ReadonlyArray<GoatBotRow>) => (
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <GoatBotChatView
        projectionRef={ref}
        visibleTurnItems={projectedItems(shown)}
        environmentId={environmentId}
        availability={{ kind: "ready", bot }}
        canOperate
        rows={shown}
        onSend={() => true}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
    </div>
  );
  await using screen = await render(view(rows));
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const loaded = [...rows, reply("old-history")];
  await screen.rerender(view(loaded));
  expect(screen.container.textContent).not.toContain("Jump to latest");
  projection.statuses.old = "live";
  await screen.rerender(view(loaded));
  expect(screen.container.textContent).not.toContain("Jump to latest");
  await screen.rerender(view([...loaded, reply("old-new-reply")]));
  expect(screen.container.textContent).toContain("Jump to latest");
  expect(projection.reads).toContain("old");
  expect(projection.reads).not.toContain("current");
});

it("failing-first: the cue survives temporary offline readiness and resets for another thread", async () => {
  projection.statuses = { old: "live", other: "live" };
  const environmentId = EnvironmentId.make("env");
  const view = (thread: string, offline: boolean, shown: ReadonlyArray<GoatBotRow>) => (
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <GoatBotChatView
        projectionRef={{ environmentId, threadId: ThreadId.make(thread) }}
        visibleTurnItems={projectedItems(shown)}
        environmentId={environmentId}
        availability={
          offline
            ? { kind: "offline", environmentId }
            : { kind: "ready", bot: { environmentId, threadId: ThreadId.make(thread) } }
        }
        canOperate
        rows={shown}
        onSend={() => true}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
    </div>
  );
  await using screen = await render(view("old", false, rows));
  const element = scroller(screen.container);
  await act(() => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const next = [...rows, reply("while-reading")];
  await screen.rerender(view("old", false, next));
  expect(screen.container.textContent).toContain("Jump to latest");
  projection.statuses.old = "empty";
  await screen.rerender(view("old", true, next));
  expect(scroller(screen.container)).toBe(element);
  expect(element.scrollTop).toBe(0);
  expect(screen.container.textContent).toContain("Jump to latest");
  projection.statuses.old = "live";
  await screen.rerender(view("old", false, next));
  expect(screen.container.textContent).toContain("Jump to latest");
  await screen.rerender(view("other", false, next));
  expect(scroller(screen.container)).not.toBe(element);
  expect(screen.container.textContent).not.toContain("Jump to latest");
});
