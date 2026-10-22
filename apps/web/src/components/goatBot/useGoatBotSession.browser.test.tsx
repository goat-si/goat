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
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { act, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    connected: boolean;
    supportsChannelLedger: boolean;
    primary: boolean;
    label?: string;
    homeTarget?: import("@goat/client-runtime/goatBot/home").GoatBotHomeTarget;
    settingsSnapshot?: object | null;
  }>,
  running: null as RunId | null,
  bootstrapped: true,
  bootstrapByEnvironment: {} as Record<string, boolean>,
  workerMissing: false,
  legacyMissing: false,
  legacyArchived: false,
  legacyDeleted: false,
  botMissing: false,
  botArchived: false,
  botDeleted: false,
  workerDeleted: false,
  archiveLoading: false,
  archiveError: null as string | null,
  archiveMissingSnapshot: false,
  shellReads: vi.fn(),
  locationReads: vi.fn(),
  paramsReads: vi.fn(),
  archiveReads: vi.fn(),
  archiveRefresh: vi.fn(),
  unarchive: vi.fn(async (): Promise<{ _tag: "Success" | "Failure"; value?: undefined }> => ({
    _tag: "Success",
  })),
}));
// The mocked hooks below stand in for store subscriptions. Like the real ones, they re-render
// their component when the test changes `state`, even under the React Compiler's memoized JSX.
const tickListeners = new Set<() => void>();
let tickVersion = 0;
function useTick() {
  return useSyncExternalStore(
    (listener) => {
      tickListeners.add(listener);
      return () => tickListeners.delete(listener);
    },
    () => tickVersion,
  );
}
function bumpTick() {
  tickVersion += 1;
  for (const listener of tickListeners) listener();
}
vi.mock("./useGoatBotHome", () => ({
  useGoatBotHome: () => undefined,
  useGoatBotHomeSettings: () => ({ moveTarget: null, busy: false, error: null }),
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./goatBotHooks", () => ({
  useGoatBotEnvironments: () => {
    useTick();
    return state.environments;
  },
  useLegacyGlobalAgentRoute: () => null,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useThreadShell: (ref: { threadId: string } | null) => {
    useTick();
    state.shellReads(ref);
    // Like shellReducer/threadShellAtom: archive and delete both drop the active shell.
    return ref === null ||
      (ref.threadId === "worker" && (state.workerMissing || state.workerDeleted)) ||
      (ref.threadId === "legacy" &&
        (state.legacyMissing || state.legacyArchived || state.legacyDeleted)) ||
      (ref.threadId === "bot" && (state.botMissing || state.botArchived || state.botDeleted))
      ? null
      : {
          runtime: { activeRunId: state.running },
          archivedAt: null,
          deletedAt: null,
        };
  },
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: () => {
    useTick();
    return items;
  },
  useEnvironmentShellsBootstrapped: (environmentId: EnvironmentId) => {
    useTick();
    return state.bootstrapByEnvironment[environmentId] ?? state.bootstrapped;
  },
}));
vi.mock("~/lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: (environmentIds: ReadonlyArray<EnvironmentId>) => {
    useTick();
    state.archiveReads(environmentIds);
    return {
      snapshots: state.archiveMissingSnapshot
        ? []
        : [
            {
              environmentId: environmentIds[0],
              snapshot: { threads: state.botArchived ? [{ id: "bot" }] : [] },
            },
          ],
      isLoading: state.archiveLoading,
      error: state.archiveError,
    };
  },
  refreshArchivedThreadsForEnvironment: state.archiveRefresh,
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.unarchive,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useConnectedEnvironmentIds: () => {
    useTick();
    return state.environments
      .filter((entry) => entry.connected)
      .map((entry) => entry.environmentId);
  },
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@goat/contracts/settings");
  return {
    ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
    usePrimarySettings: (select: (settings: { timestampFormat: "24-hour" }) => unknown) =>
      select({ timestampFormat: "24-hour" }),
    useClientSettings: (select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
// Link target assertions are paired with the real ThreadRouteView worker-branch test.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => {
    state.locationReads();
    return "/";
  },
  useParams: () => {
    state.paramsReads();
    return {};
  },
  useNavigate: () => () => Promise.resolve(),
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
import { SidebarProvider } from "../ui/sidebar";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";
import { GoatBotThreadView } from "./GoatBotThreadView";
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
async function render(count = false, sidebar = false, thread = false) {
  bumpTick();
  await act(() =>
    root.render(
      <GoatBotChannelContext.Provider value={provided}>
        {sidebar ? (
          <SidebarProvider>
            <GoatBotSidebarRow />
          </SidebarProvider>
        ) : thread ? (
          <GoatBotThreadView environmentId={environmentId} threadId={ThreadId.make("bot")} />
        ) : count ? (
          <>
            <Count />
            <Count />
          </>
        ) : (
          <>
            <Controller key={provided ? "port" : "none"} />
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
  state.legacyMissing = false;
  state.legacyArchived = false;
  state.legacyDeleted = false;
  state.botMissing = false;
  state.botArchived = false;
  state.botDeleted = false;
  state.archiveLoading = false;
  state.archiveError = null;
  state.archiveMissingSnapshot = false;
  state.shellReads.mockClear();
  state.locationReads.mockClear();
  state.paramsReads.mockClear();
  state.archiveReads.mockClear();
  state.archiveRefresh.mockClear();
  state.unarchive.mockReset();
  state.unarchive.mockImplementation(async () => ({ _tag: "Success" as const }));
  items = [];
  permission = true;
  dual = false;
  // The sidebar row only appears once someone picks GOAT Bot as the logo's mode.
  useGlobalAgentStore.setState({ ref: null, botRef: null, mode: "bot" });
  port = {
    // Like ChannelBotRegistry: only an active candidate can cause legacy_active.
    ensureBot: vi.fn(async (_env, input) => {
      const candidateRemoved = state.legacyArchived || state.legacyDeleted;
      if (input.candidateThreadId && !candidateRemoved && state.running !== null)
        throw new ChannelGatewayError({ reason: "legacy_active" });
      return {
        environmentId,
        threadId: candidateRemoved
          ? ThreadId.make("bot")
          : (input.candidateThreadId ?? ThreadId.make("bot")),
        projectId: ProjectId.make("project"),
      };
    }),
    ingest: vi.fn(async (_env, input) => receipt(input.idempotencyKey)),
    getBotStatus: vi.fn(async () => ({ bot: null, waitingCount: 0 })),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    useCanSend: () => {
      useTick();
      return permission;
    },
  };
  provided = port;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
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
  await render();
  expect(port.ensureBot).toHaveBeenCalledWith(environmentId, { candidateThreadId: "legacy" });
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
    projected("user_message", "B", {
      channel: channel("input-B", { readAt: "2026-10-12T12:09:00.000Z" }),
    }),
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
  // Messages shows one receipt, under the latest outgoing bubble, timed by when the bot read it.
  const receipt = `Read ${formatShortTimestamp("2026-10-12T12:09:00.000Z", "24-hour")}`;
  expect(container.textContent).toContain(receipt);
  expect(container.textContent?.split("Read ").length).toBe(2);
  expect(container.textContent).toContain("Intake failed");
});

it("keeps target-specific offline, loading and missing history states with summaries and requester time", async () => {
  items = [runningChip()];
  await render();
  expect(container.querySelector("a")?.getAttribute("href")).toBe(`/${environmentId}/worker`);
  expect(
    isGoatBotThread({ environmentId, id: "worker" }, useGlobalAgentStore.getState().botRef),
  ).toBe(false);
  // A request made in GOAT itself came from the reader, so the card does not name them.
  expect(container.textContent).not.toContain("Jun");
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
  expect(container.textContent).toContain(
    "Text it like a person. It answers here and does the work in its own threads.",
  );
  expect(
    [...container.querySelectorAll("button")].filter((button) =>
      [
        "Fix the flaky test in my project",
        "Review the latest changes",
        "How is the work going?",
      ].includes(button.textContent ?? ""),
    ),
  ).toHaveLength(3);
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

it("counts 102 waiting tasks from every channel across pages, dedupes, shares observers and preserves the last count on errors", async () => {
  const page1 = Array.from({ length: 100 }, (_, index) => task(index));
  vi.mocked(port.listTasks)
    .mockResolvedValueOnce({ tasks: page1, nextCursor: "next" })
    .mockResolvedValueOnce({ tasks: [task(99), task(100), task(101, "slack")] });
  await render(true);
  expect([...container.querySelectorAll("output")].map((output) => output.textContent)).toEqual([
    "102",
    "102",
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
  expect(container.querySelector("output")?.textContent).toBe("102");
  setConnection(false);
  await render(true);
  expect(container.querySelector("output")?.textContent).toBe("unknown");
  const callsBeforeFocus = vi.mocked(port.listTasks).mock.calls.length;
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(port.listTasks).toHaveBeenCalledTimes(callsBeforeFocus);
  setConnection(true);
  await render(true);
  expect(port.listTasks).toHaveBeenCalledTimes(5);
});

it("hides a badge until the first successful count and refreshes every 60 seconds only while enabled", async () => {
  using _timers = fakeTimers();
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

function legacyRef() {
  return { environmentId, threadId: ThreadId.make("legacy"), draftId: DraftId.make("draft") };
}

it("waits for shell bootstrap then sends the stopped legacy candidate for adoption", async () => {
  useGlobalAgentStore.setState({ ref: legacyRef() });
  state.bootstrapped = false;
  state.legacyMissing = true;
  await render();
  expect(port.ensureBot).not.toHaveBeenCalled();
  state.bootstrapped = true;
  state.legacyMissing = false;
  await render();
  expect(port.ensureBot).toHaveBeenCalledExactlyOnceWith(environmentId, {
    candidateThreadId: "legacy",
  });
  expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("legacy");
});

it("sends an unknown legacy candidate after bootstrap and lets the server inspect it", async () => {
  useGlobalAgentStore.setState({ ref: legacyRef() });
  state.legacyMissing = true;
  await render();
  expect(port.ensureBot).toHaveBeenCalledWith(environmentId, { candidateThreadId: "legacy" });
});

it.each(["archived", "deleted"])(
  "lets the server inspect a %s legacy candidate whose active shell is absent",
  async (kind) => {
    useGlobalAgentStore.setState({ ref: legacyRef() });
    state.legacyArchived = kind === "archived";
    state.legacyDeleted = kind === "deleted";
    state.running = RunId.make("stale-running");
    await render();
    expect(port.ensureBot).toHaveBeenCalledExactlyOnceWith(environmentId, {
      candidateThreadId: "legacy",
    });
    expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("bot");
    expect(textarea().disabled).toBe(false);
  },
);

it("retries legacy_active once when the stopped shell arrives after the server response", async () => {
  useGlobalAgentStore.setState({ ref: legacyRef() });
  state.legacyMissing = true;
  state.running = RunId.make("server-active");
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  state.running = null;
  state.legacyMissing = false;
  await render();
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("legacy");
});

it("bounds automatic legacy retries when the server stays active despite a stopped client shell", async () => {
  useGlobalAgentStore.setState({ ref: legacyRef() });
  vi.mocked(port.ensureBot).mockImplementation(async (_env, input) => {
    if (input.candidateThreadId) throw new ChannelGatewayError({ reason: "legacy_active" });
    return { environmentId, threadId: ThreadId.make("bot"), projectId: ProjectId.make("project") };
  });
  await render();
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(textarea().disabled).toBe(true);
});

it("leaves the bot alone until it is opened, then ensures once from the bot screens", async () => {
  await render(false, true);
  await render(false, true);
  expect(port.ensureBot).not.toHaveBeenCalled();
  expect(useGlobalAgentStore.getState().botRef).toBeNull();
  expect(container.querySelector('a[href="/bot"]')).not.toBeNull();
  dual = true;
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("bot");
  await render(false, false, true);
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(textarea().disabled).toBe(false);
});

it("adds no sidebar group or menu with a null port, then renders the enabled row when installed", async () => {
  provided = null;
  await render(false, true);
  expect(container.querySelector("[data-sidebar=group], [data-sidebar=menu]")).toBeNull();
  expect(port.ensureBot).not.toHaveBeenCalled();
  expect(port.listTasks).not.toHaveBeenCalled();
  expect(state.shellReads).not.toHaveBeenCalled();
  expect(state.locationReads).not.toHaveBeenCalled();
  expect(state.paramsReads).not.toHaveBeenCalled();
  provided = port;
  await render(false, true);
  expect(container.querySelectorAll("[data-sidebar=group]")).toHaveLength(1);
  expect(container.querySelectorAll("[data-sidebar=menu]")).toHaveLength(1);
  expect(container.querySelector('a[href="/bot"]')).not.toBeNull();
});

it("treats a rejected ingest as a final failed message with a reason and no retry", async () => {
  vi.mocked(port.ingest).mockResolvedValue({ ...receipt("rejected-input"), state: "rejected" });
  await render();
  await send("cannot accept");
  expect(container.textContent).toContain("GOAT Bot did not accept this message");
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
  ).toBe(false);
  expect(port.ingest).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "offers to unarchive an archived bot from the snapshot (shell previously seen: %s)",
  async (seen) => {
    if (seen) await render(false, false, true);
    state.botArchived = true;
    await render(false, false, true);
    expect(container.textContent).toContain("This chat is archived");
    expect(container.querySelector('a[href="/bot"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Unarchive",
      ),
    ).toBe(true);
    expect(textarea().disabled).toBe(true);
    expect(port.ensureBot).toHaveBeenCalledTimes(1);
    expect(state.archiveRefresh).toHaveBeenCalledExactlyOnceWith(environmentId);
    state.unarchive.mockImplementation(async () => {
      state.botArchived = false;
      return { _tag: "Success" as const };
    });
    await act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Unarchive")!
        .click(),
    );
    expect(state.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: "bot" },
    });
    expect(state.archiveRefresh).toHaveBeenCalledTimes(2);
    await render(false, false, true);
    expect(textarea().disabled).toBe(false);
    expect(port.ensureBot).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("This chat is archived");
  },
);

it("asks the server once for a replacement when the confirmed bot was deleted", async () => {
  await render(false, false, true);
  state.botDeleted = true;
  await render(false, false, true);
  // The server answers with the same deleted thread here, as an older server would.
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  await render(false, false, true);
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("This chat was deleted");
  expect(container.querySelector('a[href="/bot"]')).toBeNull();
  expect(textarea().disabled).toBe(true);
  expect(container.textContent).toContain("Couldn't start a new GOAT Bot chat.");
  await act(() =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Try again")!
      .click(),
  );
  expect(port.ensureBot).toHaveBeenCalledTimes(3);
  await render(false, false, true);
  expect(port.ensureBot).toHaveBeenCalledTimes(3);
});

it("offers the bot link only when the confirmed bot differs from the removed chat", async () => {
  await render(false, false, true);
  state.botDeleted = true;
  vi.mocked(port.ensureBot).mockResolvedValue({
    environmentId,
    threadId: ThreadId.make("replacement"),
    projectId: ProjectId.make("project"),
  });
  await render(false, false, true);
  expect(container.querySelector('a[href="/bot"]')?.textContent).toBe("Open GOAT Bot");
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Couldn't start a new GOAT Bot chat");
});

it("offers the replacement bot after reconnect even when removal happened while offline", async () => {
  await render(false, false, true);
  setConnection(false);
  state.botDeleted = true;
  await render(false, false, true);
  expect(container.querySelector('a[href="/bot"]')).toBeNull();
  vi.mocked(port.ensureBot).mockResolvedValueOnce({
    environmentId,
    threadId: ThreadId.make("replacement"),
    projectId: ProjectId.make("project"),
  });
  setConnection(true);
  await render(false, false, true);
  expect(container.querySelector('a[href="/bot"]')?.textContent).toBe("Open GOAT Bot");
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  expect(textarea().disabled).toBe(true);
});

it.each(["error", "legacy_active"])(
  "keeps a deleted bot's %s replacement failure visible and allows a manual retry",
  async (kind) => {
    await render(false, false, true);
    vi.mocked(port.ensureBot).mockRejectedValueOnce(
      kind === "error"
        ? new Error("replacement unavailable")
        : new ChannelGatewayError({ reason: "legacy_active" }),
    );
    state.botDeleted = true;
    await render(false, false, true);
    expect(port.ensureBot).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Couldn't start a new GOAT Bot chat.");
    expect(container.textContent).not.toContain("GOAT Bot is starting a new chat.");
    expect(textarea().disabled).toBe(true);
    await render(false, false, true);
    expect(port.ensureBot).toHaveBeenCalledTimes(2);
    vi.mocked(port.ensureBot).mockResolvedValueOnce({
      environmentId,
      threadId: ThreadId.make("replacement"),
      projectId: ProjectId.make("project"),
    });
    await act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Try again")!
        .click(),
    );
    expect(port.ensureBot).toHaveBeenCalledTimes(3);
    expect(container.querySelector('a[href="/bot"]')?.textContent).toBe("Open GOAT Bot");
  },
);

it("shows replacement progress only while ensure is pending, then shows failure for the same deleted bot", async () => {
  await render(false, false, true);
  const replacement = deferred<Awaited<ReturnType<GoatBotChannelPort["ensureBot"]>>>();
  vi.mocked(port.ensureBot).mockImplementationOnce(() => replacement.promise);
  state.botDeleted = true;
  await render(false, false, true);
  expect(container.textContent).toContain("GOAT Bot is starting a new chat.");
  expect(textarea().disabled).toBe(true);
  await render(false, false, true);
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
  await act(() =>
    replacement.resolve({
      environmentId,
      threadId: ThreadId.make("bot"),
      projectId: ProjectId.make("project"),
    }),
  );
  expect(container.textContent).toContain("Couldn't start a new GOAT Bot chat.");
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
});

it.each(["loading", "missing snapshot"])(
  "waits for an archived snapshot with %s before replacing a missing seen bot",
  async (kind) => {
    await render(false, false, true);
    expect(state.archiveReads).not.toHaveBeenCalled();
    state.botDeleted = true;
    state.archiveLoading = kind === "loading";
    state.archiveMissingSnapshot = kind === "missing snapshot";
    await render(false, false, true);
    expect(port.ensureBot).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("This chat was deleted");
    state.archiveLoading = false;
    state.archiveMissingSnapshot = false;
    await render(false, false, true);
    expect(port.ensureBot).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("This chat was deleted");
    expect(state.archiveRefresh).toHaveBeenCalledTimes(1);
  },
);

it("stops sending and offers Check again when the archived snapshot fails", async () => {
  await render(false, false, true);
  state.botDeleted = true;
  state.archiveError = "snapshot unavailable";
  // Like the real query, the error stays until someone refreshes the snapshot.
  state.archiveRefresh.mockImplementation(() => {
    if (state.archiveRefresh.mock.calls.length > 1) state.archiveError = null;
  });
  await render(false, false, true);
  expect(container.textContent).toContain("Couldn't check this chat");
  expect(textarea().disabled).toBe(true);
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  const checkAgain = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Check again",
  );
  await act(() => checkAgain?.click());
  await render(false, false, true);
  expect(state.archiveRefresh).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("This chat was deleted");
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
});

it("treats an archived bot that later leaves the archive as deleted", async () => {
  state.botArchived = true;
  await render(false, false, true);
  expect(container.textContent).toContain("This chat is archived");
  state.botArchived = false;
  state.botDeleted = true;
  state.archiveRefresh.mockClear();
  const unarchive = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Unarchive",
  );
  await act(async () => unarchive?.click());
  await render(false, false, true);
  expect(state.archiveRefresh).toHaveBeenCalled();
  expect(container.textContent).toContain("This chat was deleted");
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
});

it("does not offer Unarchive without permission or ask for an archived bot replacement", async () => {
  state.botArchived = true;
  permission = false;
  await render(false, false, true);
  expect(container.textContent).toContain("This chat is archived");
  expect(
    Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent === "Unarchive",
    ),
  ).toBe(false);
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(textarea().disabled).toBe(true);
});

it("keeps a just-confirmed bot awaiting its shell rather than showing removed", async () => {
  state.botMissing = true;
  await render(false, false, true);
  expect(useGlobalAgentStore.getState().botRef?.threadId).toBe("bot");
  expect(container.textContent).not.toContain("This chat was deleted");
  expect(textarea().disabled).toBe(false);
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(state.archiveRefresh).toHaveBeenCalledTimes(1);
  setConnection(false);
  await render(false, false, true);
  expect(container.textContent).not.toContain("This chat was deleted");
});

it("remounts the thread permission hook when the port is installed and removed", async () => {
  provided = null;
  await render(false, false, true);
  port = {
    ...port,
    useCanSend: () => {
      const [allowed] = useState(true);
      return allowed;
    },
  };
  provided = port;
  await render(false, false, true);
  expect(textarea().disabled).toBe(false);
  provided = null;
  await render(false, false, true);
  expect(textarea().disabled).toBe(true);
});

it("waits for claim readback before ensure, then ensures on the chosen home", async () => {
  state.environments = [
    {
      ...state.environments[0]!,
      homeTarget: {
        environmentId,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: null,
      },
    },
  ];
  await render();
  expect(port.ensureBot).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Connecting");
  const claim = { environmentId, claimedAt: 100, claimId: "claim" };
  state.environments = [
    {
      ...state.environments[0]!,
      homeTarget: { ...state.environments[0]!.homeTarget!, home: claim },
      settingsSnapshot: { goatBotHome: claim },
    },
  ];
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
});

it("does not retry not_home on unchanged snapshots, permission changes or reconnect", async () => {
  const claim = { environmentId, claimedAt: 100, claimId: "claim" };
  const target = {
    environmentId,
    connected: true,
    supportsHome: true,
    supportsBot: true,
    settingsLoaded: true,
    home: claim,
  };
  const settings = { goatBotHome: claim };
  state.environments = [
    { ...state.environments[0]!, homeTarget: target, settingsSnapshot: settings },
  ];
  vi.mocked(port.ensureBot).mockRejectedValueOnce(
    new ChannelGatewayError({ reason: "not_home", homeEnvironmentId: EnvironmentId.make("other") }),
  );
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Connecting");
  await render();
  permission = false;
  await render();
  permission = true;
  await render();
  state.environments = [
    { ...state.environments[0]!, connected: false, homeTarget: { ...target, connected: false } },
  ];
  await render();
  state.environments = [{ ...state.environments[0]!, connected: true, homeTarget: target }];
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  state.environments = [{ ...state.environments[0]!, settingsSnapshot: { ...settings } }];
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
});

it("shows a calm named offline home without ensuring on another environment", async () => {
  const offlineId = EnvironmentId.make("offline-home");
  const claim = { environmentId: offlineId, claimedAt: 100, claimId: "offline" };
  state.environments = [
    {
      ...state.environments[0]!,
      homeTarget: {
        environmentId,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: claim,
      },
    },
    {
      environmentId: offlineId,
      connected: false,
      supportsChannelLedger: true,
      primary: false,
      label: "Office Mac",
      homeTarget: {
        environmentId: offlineId,
        connected: false,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: claim,
      },
    },
  ];
  await render();
  expect(port.ensureBot).not.toHaveBeenCalled();
  expect(container.textContent).toContain("GOAT Bot runs on Office Mac, which isn't connected");
});

it("retries not_home when the winner changes even without a new settings object", async () => {
  const claim = { environmentId, claimedAt: 100, claimId: "first" };
  const settings = { goatBotHome: claim };
  const target = {
    environmentId,
    connected: true,
    supportsHome: true,
    supportsBot: true,
    settingsLoaded: true,
    home: claim,
  };
  state.environments = [
    { ...state.environments[0]!, homeTarget: target, settingsSnapshot: settings },
  ];
  vi.mocked(port.ensureBot).mockRejectedValueOnce(new ChannelGatewayError({ reason: "not_home" }));
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(1);
  state.environments = [
    {
      ...state.environments[0]!,
      homeTarget: { ...target, home: { ...claim, claimId: "second", claimedAt: 101 } },
    },
  ];
  await render();
  expect(port.ensureBot).toHaveBeenCalledTimes(2);
});
