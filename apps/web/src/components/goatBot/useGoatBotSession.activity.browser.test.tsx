import {
  OrchestrationV2TurnItemJson,
  RunId,
  type ChannelTaskChip,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  shellReads: [] as Array<string | null>,
  workerShell: { activityRunStatus: "running", pendingRuntimeRequest: null } as object,
}));

// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("./goatBotHooks", () => ({
  useGoatBotEnvironments: () => [],
  useLegacyGlobalAgentRoute: () => null,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useEnvironmentShellsBootstrapped: () => true,
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotOpenAsks: true } } }]]),
  useThreadShell: (ref: { threadId: string } | null) => {
    mocks.shellReads.push(ref?.threadId ?? null);
    return ref?.threadId === "worker-1" ? { source: mocks.workerShell } : null;
  },
}));
// One stand-in detail atom for every worker ref, so the test can play the view that loads it.
vi.mock("~/state/threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const detail = Atom.make<unknown>(null);
  // A session's steps read its quiet items, which load the same detail.
  const quietItems = Atom.make((get) => {
    get(detail);
    return [];
  });
  const history = Atom.make({ hasMoreHistory: false });
  const timelineItems = Atom.make<ReadonlyArray<never>>([]);
  return {
    ...(await importOriginal<typeof import("~/state/threads")>()),
    environmentThreadDetails: {
      statusAtom: () => Atom.make("live"),
      threadAtom: () => detail,
      quietVisibleTurnItemsAtom: () => quietItems,
      timelineVisibleTurnItemsAtom: () => timelineItems,
      historyAtom: () => history,
    },
  };
});

import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import { GoatBotStepsProvider, GoatBotStepsReader } from "./GoatBotStepsProvider";
import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";
import { useGoatBotSession } from "./useGoatBotSession";

const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = "2026-10-28T12:00:00.000Z";
const detailAtom = environmentThreadDetails.threadAtom({
  environmentId: "env",
  threadId: "worker-1",
} as never) as unknown as Atom.Writable<unknown>;

function setup(shell: object = { activityRunStatus: "running", pendingRuntimeRequest: null }) {
  mocks.shellReads.length = 0;
  mocks.workerShell = shell;
}

function conversation(task: Partial<ChannelTaskChip> = {}): OrchestrationV2ProjectedTurnItem[] {
  const base = {
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const meta = { conversationId: "conv-1", originKind: "goat" };
  const items = [
    {
      ...base,
      id: "in",
      ordinal: 0,
      type: "user_message",
      messageId: "m-in",
      inputIntent: "turn_start",
      text: "Check the disks",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      channel: { ...meta, kind: "inbound", inputId: "in-1", readAt: at },
    },
    {
      ...base,
      id: "ack",
      ordinal: 1,
      type: "assistant_message",
      messageId: "m-ack",
      text: "Checking now.",
      streaming: false,
      channel: { ...meta, kind: "receipt", inReplyToInputId: "in-1", taskId: "task-1" },
    },
    {
      ...base,
      id: "card",
      ordinal: 2,
      type: "notification",
      source: { kind: "background_task" },
      outcome: "updated",
      summary: "Work updated",
      ledgerTask: {
        taskId: "task-1",
        conversationId: "conv-1",
        taskVersion: 1,
        title: "Check the disks",
        status: "running",
        originKind: "goat",
        requesterLabel: "Jun",
        createdAt: at,
        updatedAt: at,
        worker: { environmentId: "env", threadId: "worker-1" },
        openQuestionCount: 0,
        ...task,
      },
    },
  ].map((json) => decode(json));
  return items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function Conversation({ items }: { readonly items: OrchestrationV2ProjectedTurnItem[] }) {
  const session = useGoatBotSession(items);
  return (
    <GoatBotActivityContext value={session.activity}>
      <GoatBotTimeline rows={[]} onRetry={() => {}} />
    </GoatBotActivityContext>
  );
}

/** The main chat as GoatBotThreadView renders it, with the steps of its turns' sessions. */
function MainChat({
  items,
  paused = false,
}: {
  readonly items: OrchestrationV2ProjectedTurnItem[];
  readonly paused?: boolean;
}) {
  const session = useGoatBotSession(items);
  return (
    <AppAtomRegistryProvider>
      <GoatBotActivityContext value={session.activity}>
        <GoatBotStepsProvider visibleTurnItems={items} environmentId={"env" as never}>
          <GoatBotStepsReader rows={session.rows} paused={paused}>
            <GoatBotTimeline rows={[]} onRetry={() => {}} />
          </GoatBotStepsReader>
        </GoatBotStepsProvider>
      </GoatBotActivityContext>
    </AppAtomRegistryProvider>
  );
}

const sessionWorker = { environmentId: "env", threadId: "worker-1", runId: "run-1" } as never;
const turnWorker = {
  environmentId: "env",
  threadId: "goat-bot-session:s1",
  runId: "run-1",
} as never;

// A session run waiting on approval while its tool call runs; only the approval may show.
const projection = (requestStatus: "pending" | "resolved") => ({
  environmentId: "env",
  projection: {
    runs: [{ id: "run-1", status: "running" }],
    nodes: [{ id: "node-1", runId: "run-1" }],
    runtimeRequests: [{ nodeId: "node-1", kind: "command", status: requestStatus }],
    turnItems: [
      {
        type: "command_execution",
        runId: RunId.make("run-1"),
        status: "running",
        title: "Run df -h",
        updatedAt: DateTime.makeUnsafe(at),
      },
    ],
  },
});

it("follows the acknowledged task's worker without loading its detail", async () => {
  setup({ activityRunStatus: "preparing", pendingRuntimeRequest: null });
  await using screen = await render(<Conversation items={conversation()} />, { router: false });
  await expect.element(screen.getByRole("button", { name: /^Starting/ })).toBeVisible();
  expect(mocks.shellReads).toContain("worker-1");
  expect(appAtomRegistry.getNodes().has(detailAtom)).toBe(false);
});

it("updates from a detail-only change while another view keeps the worker loaded", async () => {
  setup();
  appAtomRegistry.set(detailAtom, projection("pending"));
  const unmountOtherView = appAtomRegistry.mount(detailAtom);
  try {
    await using screen = await render(
      <Conversation items={conversation({ worker: sessionWorker })} />,
      { router: false },
    );
    await expect
      .element(screen.getByRole("button", { name: /^Waiting for your approval/ }))
      .toBeVisible();
    await act(() => appAtomRegistry.set(detailAtom, projection("resolved")));
    await expect.element(screen.getByRole("button", { name: /^Working/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /Run df -h/ })).not.toBeInTheDocument();
  } finally {
    unmountOtherView();
  }
});

it("never reads a remote worker through a local thread with the same id", async () => {
  setup({ activityRunStatus: "waiting", pendingRuntimeRequest: null });
  appAtomRegistry.set(detailAtom, projection("pending"));
  const unmountOtherView = appAtomRegistry.mount(detailAtom);
  try {
    const remote = conversation({
      summary: "Copying files on mac-studio",
      worker: { environmentId: "env", threadId: "worker-1", host: "mac-studio" } as never,
    });
    await using screen = await render(<Conversation items={remote} />, { router: false });
    await expect
      .element(screen.getByRole("button", { name: /^Copying files on mac-studio/ }))
      .toBeVisible();
    expect(mocks.shellReads).not.toContain("worker-1");
  } finally {
    unmountOtherView();
  }
});

it("keeps a turn's session loaded in the main chat, so the live line reads its run's pending request", async () => {
  setup();
  appAtomRegistry.set(detailAtom, projection("pending"));
  // No other view holds the session: the main chat's steps keep it loaded.
  await using screen = await render(
    <MainChat items={conversation({ kind: "turn", worker: turnWorker })} />,
    { router: false },
  );
  await expect
    .element(screen.getByRole("button", { name: /^Waiting for your approval/ }))
    .toBeVisible();
  expect(appAtomRegistry.getNodes().has(detailAtom)).toBe(true);
});

it("stops reading the turn's session steps while a file covers the main chat, and reads them again after", async () => {
  setup();
  appAtomRegistry.set(detailAtom, projection("pending"));
  const items = conversation({ kind: "turn", worker: turnWorker });
  // The status line's own listener lets go of the detail within seconds of the last reader.
  const steps = environmentThreadDetails.quietVisibleTurnItemsAtom(turnWorker);
  await using screen = await render(<MainChat items={items} />, { router: false });
  await vi.waitFor(() => expect(appAtomRegistry.getNodes().has(steps)).toBe(true));
  await screen.rerender(<MainChat items={items} paused />);
  await vi.waitFor(() => expect(appAtomRegistry.getNodes().has(steps)).toBe(false));
  await screen.rerender(<MainChat items={items} />);
  await vi.waitFor(() => expect(appAtomRegistry.getNodes().has(steps)).toBe(true));
});
