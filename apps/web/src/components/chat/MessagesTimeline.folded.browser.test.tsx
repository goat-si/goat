import {
  EnvironmentId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { collectThreadFindRanges } from "./threadFindHighlights";
import {
  CREATED_AT,
  ENVIRONMENT_ID,
  click,
  message,
  renderTimeline,
} from "./MessagesTimeline.browserHarness";

const environmentQuery = vi.hoisted(() => ({ data: null as unknown }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  })) as never,
}));
const threadShells = vi.hoisted(
  () => new Map<string, { readonly title: string; readonly deletedAt: string | null }>(),
);
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((
    ref: { readonly environmentId: string; readonly threadId: string } | null,
  ) => (ref && threadShells.get(`${ref.environmentId}/${ref.threadId}`)) ?? null) as never,
}));

function setup({
  scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }>,
  shells = [] as ReadonlyArray<{
    id: string;
    title: string;
    deletedAt?: string;
    environmentId?: EnvironmentId;
  }>,
} = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
  threadShells.clear();
  for (const shell of shells) {
    threadShells.set(`${shell.environmentId ?? ENVIRONMENT_ID}/${shell.id}`, {
      title: shell.title,
      deletedAt: shell.deletedAt ?? null,
    });
  }
}

const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointReady: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

const SENDER_THREAD_ID = ThreadId.make("thread-sender");
const AGENT_MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

describe("MessagesTimeline agent messages", () => {
  it("folds a message from a thread this app does not hold under a plain sent-from label", async () => {
    setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Sent from another thread");
    expect(screen.buttons(/^Open /)).toHaveLength(0);
    const toggle = screen.button("Review finished");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("drops the index");

    await click(toggle);
    expect(screen.text()).toContain("The migration drops the index before backfilling it.");
    await click(screen.button("Open thread"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID);
  });

  it("names a known sender above the message and opens it at the call that sent it", async () => {
    setup({ shells: [{ id: SENDER_THREAD_ID, title: "CU100 merge manager" }] });
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Sent by CU100 merge manager from another thread");
    const toggle = screen.button("Review finished");

    await click(screen.button("Open CU100 merge manager"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID, {
      sentFrom: {
        threadId: expect.stringMatching(/^thread-/),
        messageId: MessageId.make("message-1"),
        senderThreadId: SENDER_THREAD_ID,
        activation: expect.any(String),
      },
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("points an inherited message at the thread it was delivered to", async () => {
    setup({ shells: [{ id: SENDER_THREAD_ID, title: "CU100 merge manager" }] });
    const onOpenThread = vi.fn();
    const inherited = {
      ...message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
      projectedItem: {
        position: 0,
        visibility: "inherited",
        sourceThreadId: ThreadId.make("thread-original"),
        sourceItemId: "item-1",
        item: { threadId: ThreadId.make("thread-original") },
      } as unknown as OrchestrationV2ProjectedTurnItem,
    };
    await using screen = await renderTimeline([inherited], { onOpenThread });
    await click(screen.button("Open CU100 merge manager"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID, {
      sentFrom: expect.objectContaining({ threadId: "thread-original" }),
    });
  });

  it("names a deleted sender without a link", async () => {
    setup({
      shells: [
        { id: SENDER_THREAD_ID, title: "CU100 merge manager", deletedAt: "2026-03-18T00:00:00Z" },
      ],
    });
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
    ]);
    expect(screen.text()).toContain("Sent by CU100 merge manager from another thread");
    expect(screen.buttons(/^Open /)).toHaveLength(0);
  });

  it("does not link a sender held only by another environment", async () => {
    setup({
      shells: [
        {
          id: SENDER_THREAD_ID,
          title: "CU100 merge manager",
          environmentId: EnvironmentId.make("environment-remote"),
        },
      ],
    });
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
    ]);
    expect(screen.text()).toContain("Sent from another thread");
    expect(screen.buttons(/^Open /)).toHaveLength(0);
  });

  it("names the toggle after the sender when the message has no text", async () => {
    setup({ shells: [{ id: SENDER_THREAD_ID, title: "CU100 merge manager" }] });
    await using screen = await renderTimeline([
      message("", { createdBy: "agent", senderThreadId: SENDER_THREAD_ID }),
    ]);
    const toggle = screen.button("Message from CU100 merge manager");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not mark a message from another thread as a steer", async () => {
    setup({ shells: [{ id: SENDER_THREAD_ID, title: "CU100 merge manager" }] });
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, {
        createdBy: "agent",
        senderThreadId: SENDER_THREAD_ID,
        inputIntent: "steer",
      }),
    ]);
    expect(screen.text()).toContain("Sent by CU100 merge manager");
    expect(screen.text()).not.toContain("Steer");
  });

  it("leaves messages sent by GOAT as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons(/^Agent/)).toHaveLength(0);
    expect(screen.text()).toContain("drops the index");
  });

  it("reveals a find match inside a folded agent message", async () => {
    setup();
    const text = `${"Checked the next file.\n\n".repeat(16)}The migration drops the index.`;
    await using screen = await renderTimeline(
      [message(text, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      {
        findExpanded: true,
        findQuery: "drops the index",
        activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
      },
    );
    await vi.waitFor(() =>
      expect(screen.button(/^Checked the next file/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "drops the index")[0]!;
    const body = screen.container.querySelector("[data-user-message-body]")!;
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().bottom,
    );
  });
});
