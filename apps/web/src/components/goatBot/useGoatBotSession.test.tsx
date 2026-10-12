// @vitest-environment jsdom

import {
  ChannelBindingId,
  ChannelConversationId,
  ChannelGatewayError,
  ChannelInputId,
  ChannelTaskId,
  EnvironmentId,
  MessageId,
  OrchestrationV2TurnItemJson,
  ProjectId,
  RunId,
  ThreadId,
  type ChannelIngestResult,
  type ChannelTask,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    connected: boolean;
    supportsChannelLedger: boolean;
    primary: boolean;
  }>,
  running: null as RunId | null,
  bootstrapped: true,
  bootstrapByEnvironment: {} as Record<string, boolean>,
  workerMissing: false,
  workerDeleted: false,
}));
vi.mock("./goatBotHooks", () => ({
  useGoatBotEnvironments: () => state.environments,
  useLegacyGlobalAgentRoute: () => null,
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null || (ref.threadId === "worker" && state.workerMissing)
      ? null
      : {
          runtime: { activeRunId: state.running },
          archivedAt: null,
          deletedAt:
            ref.threadId === "worker" && state.workerDeleted ? "2026-10-12T12:03:00.000Z" : null,
        },
  useEnvironmentShellsBootstrapped: (environmentId: EnvironmentId) =>
    state.bootstrapByEnvironment[environmentId] ?? state.bootstrapped,
}));
vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () =>
    state.environments.filter((entry) => entry.connected).map((entry) => entry.environmentId),
}));
vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: "24-hour" }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
// Link target assertions are paired with the real ThreadRouteView worker-branch test.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { environmentId?: string; threadId?: string; draftId?: string };
    children?: ReactNode;
  }) => (
    <a
      {...props}
      href={to
        .replace("$environmentId", params?.environmentId ?? "")
        .replace("$threadId", params?.threadId ?? "")
        .replace("$draftId", params?.draftId ?? "")}
    >
      {children}
    </a>
  ),
}));

import { DraftId } from "~/composerDraftStore";
import { formatShortTimestamp } from "~/timestampFormat";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { isGoatBotThread, globalAgentLogoTarget } from "~/globalAgentRoute";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { goatBotEnabled, useGoatBotSession } from "./useGoatBotSession";
import { refreshGoatBotWaitingCount, useGoatBotWaitingCount } from "./useGoatBotWaitingCount";

const at = "2026-10-12T12:00:00.000Z";
let root: Root;
let container: HTMLDivElement;
let sequence = 0;
let environmentId: EnvironmentId;
let items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
let port: GoatBotChannelPort;
let permission: boolean;
let dual: boolean;
let provided: GoatBotChannelPort | null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function receipt(key: string): ChannelIngestResult {
  return {
    inputId: ChannelInputId.make(key),
    conversationId: ChannelConversationId.make("conversation"),
    bindingId: ChannelBindingId.make("binding"),
    duplicate: false,
    state: "accepted",
    acceptedAt: at,
    taskIds: [],
  };
}
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

function projected(
  type: "user_message" | "assistant_message" | "notification",
  id: string,
  extras: Record<string, unknown> = {},
): OrchestrationV2ProjectedTurnItem {
  const item = decodeItem({
    id,
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type,
    ...(type === "user_message"
      ? {
          messageId: id,
          inputIntent: "turn_start",
          text: id,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        }
      : type === "assistant_message"
        ? { messageId: id, text: id, streaming: false }
        : { source: { kind: "background_task" }, outcome: "updated", summary: "Work" }),
    ...extras,
  });
  return {
    item,
    position: 0,
    visibility: "local",
    sourceThreadId: ThreadId.make("bot"),
    sourceItemId: item.id,
  };
}
function channel(inputId: string, extra: Record<string, unknown> = {}) {
  return { conversationId: "conversation", originKind: "goat", kind: "inbound", inputId, ...extra };
}
function runningChip() {
  return projected("notification", "chip", {
    ledgerTask: {
      taskId: "task",
      conversationId: "conversation",
      taskVersion: 1,
      title: "Running job",
      status: "running",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at,
      updatedAt: "2026-10-12T12:02:00.000Z",
      openQuestionCount: 0,
      worker: { environmentId, threadId: "worker" },
      summary: "Result stays visible",
    },
  });
}
function Controller({ entry = false }: { entry?: boolean }) {
  const session = useGoatBotSession(entry ? undefined : items);
  return entry ? (
    <div data-entry={session.availability.kind} />
  ) : (
    <GoatBotChatView
      {...session}
      legacyAgentRoute={{ kind: "thread", environmentId, threadId: ThreadId.make("legacy") }}
    />
  );
}
function Count() {
  const count = useGoatBotWaitingCount();
  return <output>{count === undefined ? "unknown" : count}</output>;
}
async function render(count = false) {
  await act(() =>
    root.render(
      <GoatBotChannelContext.Provider value={provided}>
        {count ? (
          <>
            <Count />
            <Count />
          </>
        ) : (
          <>
            <Controller />
            {dual ? <Controller entry /> : null}
          </>
        )}
      </GoatBotChannelContext.Provider>,
    ),
  );
}
async function send(text: string) {
  const textarea = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
}
function textarea() {
  return container.querySelector("textarea")!;
}
function setConnection(connected: boolean, capability = true) {
  state.environments = [
    { environmentId, connected, supportsChannelLedger: capability, primary: true },
  ];
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  environmentId = EnvironmentId.make(`session-${++sequence}`);
  setConnection(true);
  state.running = null;
  state.bootstrapped = true;
  state.bootstrapByEnvironment = {};
  state.workerMissing = false;
  state.workerDeleted = false;
  items = [];
  permission = true;
  dual = false;
  useGlobalAgentStore.setState({ ref: null, botRef: null });
  port = {
    ensureBot: vi.fn(async () => ({
      environmentId,
      threadId: ThreadId.make("bot"),
      projectId: ProjectId.make("project"),
    })),
    ingest: vi.fn(async (_env, input) => receipt(input.idempotencyKey)),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    useCanSend: () => permission,
  };
  provided = port;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("sends a second message while a running chip has no reply, with independent keys and an enabled composer", async () => {
  items = [runningChip()];
  await render();
  await send("first");
  await send("second");
  expect(port.ingest).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(port.ingest).mock.calls;
  expect(calls[0]![1].idempotencyKey).not.toBe(calls[1]![1].idempotencyKey);
  expect(calls[0]![0]).toBe(environmentId);
  expect(calls[0]![1]).toMatchObject({
    kind: "goat",
    connectionId: "goat",
    conversationKey: "bot",
    actor: {},
    attachments: [],
    intent: "message",
    replyAddress: { kind: "goat", environmentId, threadId: "bot" },
  });
  expect(calls[0]![1].externalMessageId).toBe(calls[0]![1].idempotencyKey);
  expect(textarea().disabled).toBe(false);
  expect(container.textContent).toContain("Sent");
  expect(container.textContent).toContain("Running job");
});

it("queues the second submit until the first receipt arrives without blocking editing", async () => {
  const first = deferred<ChannelIngestResult>();
  vi.mocked(port.ingest).mockImplementationOnce(() => first.promise);
  await render();
  await send("first");
  await send("second");
  expect(port.ingest).toHaveBeenCalledTimes(1);
  expect(textarea().disabled).toBe(false);
  await act(() => first.resolve(receipt("first-input")));
  expect(port.ingest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(port.ingest).mock.calls.map((call) => call[1].text)).toEqual([
    "first",
    "second",
  ]);
});

it.each(["null port", "no capability"])(
  "keeps unsupported %s readable and prevents ingest",
  async (kind) => {
    if (kind === "null port") provided = null;
    else setConnection(true, false);
    await render();
    await send("not sent");
    expect(container.textContent).toContain("This server doesn't support GOAT Bot");
    expect(textarea().disabled).toBe(true);
    expect(port.ingest).not.toHaveBeenCalled();
    expect(port.ensureBot).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "shows the offline banner with rows=%s, preserves history and ensures once on reconnect",
  async (withRows) => {
    items = withRows
      ? [projected("user_message", "Existing history", { channel: channel("existing") })]
      : [];
    await render();
    setConnection(false);
    await render();
    expect(container.querySelector("header + [role=status]")?.textContent).toContain("offline");
    expect(textarea().disabled).toBe(true);
    if (withRows) expect(container.textContent).toContain("Existing history");
    setConnection(true);
    await render();
    expect(port.ensureBot).toHaveBeenCalledTimes(2);
    items = [...items, projected("assistant_message", "New reply")];
    await render();
    expect(container.textContent).toContain("New reply");
    expect(textarea().disabled).toBe(false);
  },
);

it("shares ensure across entry and thread views and discards responses invalidated by capability or reconnect", async () => {
  dual = true;
  const old = deferred<Awaited<ReturnType<GoatBotChannelPort["ensureBot"]>>>();
  vi.mocked(port.ensureBot).mockImplementationOnce(() => old.promise);
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(container.querySelector("header + [role=status]")?.textContent).toContain("Connecting");
  setConnection(false);
  await render();
  setConnection(true, false);
  await render();
  await act(() =>
    old.resolve({
      environmentId,
      threadId: ThreadId.make("stale"),
      projectId: ProjectId.make("project"),
    }),
  );
  expect(useGlobalAgentStore.getState().botRef).toBeNull();
  setConnection(true);
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("bot");
});

it("retries legacy_active once after activeRunId stops, then adopts only the same environment's stopped legacy thread", async () => {
  useGlobalAgentStore.setState({
    ref: {
      environmentId,
      threadId: ThreadId.make("legacy"),
      draftId: DraftId.make("legacy-draft"),
    },
  });
  state.running = RunId.make("run");
  dual = true;
  vi.mocked(port.ensureBot).mockRejectedValueOnce(
    new ChannelGatewayError({ reason: "legacy_active" }),
  );
  await render();
  expect(port.ensureBot).toHaveBeenCalledWith(environmentId, {});
  expect(container.textContent).toContain("becomes GOAT Bot when it finishes");
  expect(container.querySelector('a[href$="/legacy"]')?.textContent).toBe("Open global agent");
  expect(textarea().disabled).toBe(true);
  state.running = null;
  await render();
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(port.ensureBot).toHaveBeenLastCalledWith(environmentId, { candidateThreadId: "legacy" });
});

it("never adopts a legacy agent from a different environment", async () => {
  useGlobalAgentStore.setState({
    ref: {
      environmentId: EnvironmentId.make("other"),
      threadId: ThreadId.make("legacy"),
      draftId: DraftId.make("draft"),
    },
  });
  await render();
  expect(port.ensureBot).toHaveBeenCalledWith(environmentId, {});
});

it("retries the exact input and drops the optimistic bubble when projection precedes the late receipt", async () => {
  const late = deferred<ChannelIngestResult>();
  vi.mocked(port.ingest)
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => late.promise);
  await render();
  await send("hello");
  const first = vi.mocked(port.ingest).mock.calls[0]![1];
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(() => retry.click());
  expect(vi.mocked(port.ingest).mock.calls[1]![1]).toEqual(first);
  items = [
    projected("user_message", first.idempotencyKey, {
      messageId: MessageId.make(first.idempotencyKey),
      text: "hello",
      channel: channel("input-1"),
    }),
  ];
  await render();
  expect(
    [...container.querySelectorAll("li")].filter((row) => row.textContent?.includes("hello")),
  ).toHaveLength(1);
  await act(() => late.resolve(receipt("input-1")));
  expect(
    [...container.querySelectorAll("li")].filter((row) => row.textContent?.includes("hello")),
  ).toHaveLength(1);
});

it("keeps server reply order, quotes distant input and uses readAt rather than the sent time", async () => {
  items = [
    projected("user_message", "A", {
      channel: channel("input-A", { readAt: "2026-10-12T12:07:00.000Z" }),
    }),
    projected("user_message", "B", { channel: channel("input-B") }),
    projected("assistant_message", "Reply B", {
      channel: channel("reply-B", { kind: "receipt", inReplyToInputId: "input-B" }),
    }),
    projected("assistant_message", "Reply A", {
      channel: channel("reply-A", { kind: "receipt", inReplyToInputId: "input-A" }),
    }),
    projected("assistant_message", "Intake failed", {
      channel: channel("failure", { kind: "failure", inReplyToInputId: "input-B" }),
    }),
  ];
  await render();
  expect([...container.querySelectorAll("blockquote")].map((quote) => quote.textContent)).toEqual([
    "A",
    "B",
  ]);
  const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
  expect(rows.findIndex((row) => row?.includes("Reply B"))).toBeLessThan(
    rows.findIndex((row) => row?.includes("Reply A")),
  );
  expect(rows.find((row) => row?.endsWith("A"))).toContain(
    formatShortTimestamp("2026-10-12T12:07:00.000Z", "24-hour"),
  );
  expect(container.textContent).toContain("Read");
  expect(container.textContent).toContain("Sent");
  expect(container.querySelector(".border-destructive\\/32")?.textContent).toContain(
    "Intake failed",
  );
});

it("keeps target-specific offline, loading and missing history states with summaries and requester time", async () => {
  items = [runningChip()];
  await render();
  expect(container.querySelector("a")?.getAttribute("href")).toBe(`/${environmentId}/worker`);
  expect(
    isGoatBotThread({ environmentId, id: "worker" }, useGlobalAgentStore.getState().botRef),
  ).toBe(false);
  expect(container.textContent).toContain("Jun");
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-12T12:02:00.000Z");
  setConnection(false);
  await render();
  expect(container.textContent).toContain("Can't reach the work computer");
  setConnection(true);
  state.bootstrapped = false;
  await render();
  expect(container.textContent).toContain("Loading work history");
  state.bootstrapped = true;
  state.bootstrapByEnvironment = {};
  state.workerMissing = true;
  await render();
  expect(container.textContent).toContain("Work history not found");
  expect(container.textContent).toContain("Result stays visible");
  state.workerMissing = false;
  state.workerDeleted = true;
  await render();
  expect(container.textContent).toContain("Work history not found");
  expect(container.textContent).toContain("Result stays visible");
  items = [
    projected("notification", "received", {
      ledgerTask: {
        ...runningChip().item,
        taskId: "task",
        conversationId: "conversation",
        taskVersion: 1,
        title: "New job",
        status: "received",
        originKind: "slack",
        requesterLabel: "Jun",
        createdAt: at,
        updatedAt: at,
        openQuestionCount: 0,
      },
    }),
  ];
  await render();
  expect(container.textContent).toContain("Not started yet");
  expect(container.textContent).toContain("Slack · Jun");
});

it("renders an introduction and three actionable examples when ready and empty", async () => {
  await render();
  expect(container.textContent).toContain("It answers here and starts the work in its own threads");
  expect(container.querySelectorAll("ul li")).toHaveLength(3);
});

it("respects permission loss without disabling reading", async () => {
  await render();
  permission = false;
  await render();
  await send("blocked");
  expect(textarea().disabled).toBe(true);
  expect(port.ingest).not.toHaveBeenCalled();
});

function task(index: number, origin: "goat" | "slack" = "goat"): ChannelTask {
  return {
    taskId: ChannelTaskId.make(`task-${index}`),
    conversationId: ChannelConversationId.make("conversation"),
    originBindingId: ChannelBindingId.make("binding"),
    originAddress:
      origin === "goat"
        ? { kind: "goat", environmentId, threadId: ThreadId.make("bot") }
        : {
            kind: "slack",
            connectionId: "slack",
            teamId: "team",
            channelId: "channel",
            rootTs: "root",
          },
    originInputId: ChannelInputId.make("input"),
    requester: {
      ownerId: "owner",
      principalId: "user",
      displayName: "Jun",
      originKind: origin,
      runtimeModeCeiling: "full-access",
      grantedScopes: [],
    },
    title: "Work",
    instruction: "",
    status: "waiting_input",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
  };
}

it("counts 101 GOAT waiting tasks across pages, dedupes, shares observers and preserves the last count on errors", async () => {
  const page1 = Array.from({ length: 100 }, (_, index) => task(index));
  vi.mocked(port.listTasks)
    .mockResolvedValueOnce({ tasks: page1, nextCursor: "next" })
    .mockResolvedValueOnce({ tasks: [task(99), task(100), task(101, "slack")] });
  await render(true);
  expect([...container.querySelectorAll("output")].map((output) => output.textContent)).toEqual([
    "101",
    "101",
  ]);
  expect(port.listTasks).toHaveBeenCalledTimes(2);
  expect(port.listTasks).toHaveBeenLastCalledWith(environmentId, {
    status: ["waiting_input"],
    limit: 100,
    cursor: "next",
  });
  vi.mocked(port.listTasks)
    .mockResolvedValueOnce({ tasks: [], nextCursor: "error" })
    .mockRejectedValueOnce(new Error("offline"));
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector("output")?.textContent).toBe("101");
  setConnection(false);
  await render(true);
  setConnection(true);
  await render(true);
  expect(port.listTasks).toHaveBeenCalledTimes(5);
});

it("hides a badge until the first successful count and refreshes every 60 seconds only while enabled", async () => {
  vi.useFakeTimers();
  vi.mocked(port.listTasks).mockRejectedValueOnce(new Error("offline"));
  await render(true);
  expect(container.querySelector("output")?.textContent).toBe("unknown");
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(port.listTasks).toHaveBeenCalledTimes(2);
  expect(container.querySelector("output")?.textContent).toBe("0");
  provided = null;
  await render(true);
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(port.listTasks).toHaveBeenCalledTimes(2);
});

it("uses one logo predicate for the injected port and chosen environment", () => {
  expect(globalAgentLogoTarget(goatBotEnabled(port, state.environments[0]!))).toEqual({
    to: "/bot",
    label: "Open GOAT Bot",
  });
  expect(globalAgentLogoTarget(goatBotEnabled(null, state.environments[0]!))).toEqual({
    to: "/",
    label: "Open global agent",
  });
  expect(goatBotEnabled(port, { ...state.environments[0]!, supportsChannelLedger: false })).toBe(
    false,
  );
});

it("uses the remote worker's connection and bootstrap while the bot remains available", async () => {
  const remoteId = EnvironmentId.make("remote-worker");
  const chip = runningChip();
  if (chip.item.type !== "notification" || !chip.item.ledgerTask)
    throw new Error("expected a chip");
  items = [
    {
      ...chip,
      item: {
        ...chip.item,
        ledgerTask: {
          ...chip.item.ledgerTask,
          worker: { environmentId: remoteId, threadId: ThreadId.make("worker") },
        },
      },
    },
  ];
  await render();
  expect(container.textContent).toContain("Can't reach the work computer");
  expect(textarea().disabled).toBe(false);
  state.environments = [
    ...state.environments,
    { environmentId: remoteId, connected: true, supportsChannelLedger: false, primary: false },
  ];
  state.bootstrapByEnvironment[remoteId] = false;
  await render();
  expect(container.textContent).toContain("Loading work history");
  state.bootstrapByEnvironment[remoteId] = true;
  state.bootstrapByEnvironment[environmentId] = false;
  await render();
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/remote-worker/worker");
  expect(textarea().disabled).toBe(false);
});

it("refreshes after chip updates even when a previous task-page request is pending", async () => {
  const first = deferred<Awaited<ReturnType<GoatBotChannelPort["listTasks"]>>>();
  vi.mocked(port.listTasks)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ tasks: [task(1)] });
  await render(true);
  await act(() => refreshGoatBotWaitingCount(environmentId, "task:2"));
  expect(port.listTasks).toHaveBeenCalledTimes(1);
  await act(() => first.resolve({ tasks: [] }));
  expect(port.listTasks).toHaveBeenCalledTimes(2);
  expect(container.querySelector("output")?.textContent).toBe("1");
});
