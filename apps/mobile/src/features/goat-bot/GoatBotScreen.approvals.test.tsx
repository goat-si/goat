import "./goatBotScreenTestHarness";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ChannelTaskChip,
  ChannelTaskId,
  EnvironmentId,
  HubNodesSnapshot,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { expect, it, vi } from "vite-plus/test";

import {
  render,
  screenSession,
  setupTaskNavigation,
  threadReads,
} from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";
import MobileBotApprovals from "./MobileBotApprovals";
import { appAtomRegistry } from "../../state/atom-registry";

const fixture = vi.hoisted(() => ({
  respond: vi.fn(),
}));
const hubRoutes = Schema.decodeUnknownSync(HubNodesSnapshot)({
  hubEnvironmentId: "main",
  notices: [],
  nodes: [
    { host: "mini", environmentId: "remote", status: "online" },
    { host: "restricted-host", environmentId: "denied", status: "online" },
    { host: "offline-host", environmentId: "offline", status: "offline" },
  ].map(({ host, environmentId, status }) => ({
    nodeId: environmentId,
    environmentId,
    label: host,
    kind: "ssh",
    status,
    lastSeenAt: null,
    addedBy: null,
    routes: [
      {
        routeId: `ssh:${host}`,
        source: "registered",
        target: { kind: "ssh", alias: host, hostname: null, username: null, port: null },
        status,
        checkedAt: null,
        lastSeenAt: null,
        lastError: null,
      },
    ],
  })),
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    hubNodesLive: () => Atom.make(AsyncResult.success(hubRoutes)),
  },
}));
const canOperate = Atom.make(false);
const presentations = vi.hoisted(
  () =>
    new Map([
      ["main", { connection: { phase: "connected" } }],
      ["work", { connection: { phase: "connected" } }],
      ["remote", { connection: { phase: "connected" } }],
      ["denied", { connection: { phase: "connected" } }],
      ["offline", { connection: { phase: "disconnected" } }],
    ]),
);
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      presentationsAtom: Atom.make(presentations),
      presentationAtom: Atom.family((id: string) => Atom.make(presentations.get(id))),
    },
  };
});
vi.mock("../../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironmentScope: () => useAtomValue(canOperate),
    sessionHasScope: (id: string) => id !== "denied",
    readEnvironmentScope: (id: string, scope: string) =>
      id !== "denied" && scope === AuthOrchestrationReadScope,
    environmentSession: { sessionStateAtom: Atom.family((id: string) => Atom.make(id)) },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "respond" ? fixture.respond : vi.fn()),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

const at = "2026-11-21T10:00:00.000Z";
const taskId = ChannelTaskId.make("task");
const to = (worker: string, host = "studio", requestId = "approval", environmentId?: string) => ({
  kind: "approval",
  since: at,
  approval: {
    requestId,
    threadId: worker,
    host,
    environmentId,
  },
});
const decodeChip = Schema.decodeUnknownSync(ChannelTaskChip);
const chip = decodeChip({
  taskId,
  conversationId: "conversation",
  taskVersion: 1,
  title: "Update docs",
  status: "running",
  originKind: "goat",
  requesterLabel: "Owner",
  createdAt: at,
  updatedAt: at,
  openQuestionCount: 0,
  worker: { environmentId: "work", threadId: "connected", host: "studio" },
  observed: {
    pullRequests: [],
    needsYou: [
      to("connected", "studio", "approval", "work"),
      to("loading", "studio", "approval", "work"),
      to("connected", "mini", "approval", "remote"),
      to("connected", "mini", "second-approval", "remote"),
      to("unavailable", "unknown"),
      to("restricted", "restricted-host", "approval", "denied"),
      to("copied", "offline-host", "approval", "offline"),
    ],
  },
});
const offlineChip = decodeChip({
  ...chip,
  taskId: "offline-task",
  title: "Update examples",
  worker: { environmentId: "offline", threadId: "offline", host: "studio" },
  observed: { pullRequests: [], needsYou: [to("offline")] },
});

it("counts observed workers on the task screen before requests load, and links only authorized reachable workers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setupTaskNavigation();
  appAtomRegistry.set(canOperate, false);
  fixture.respond.mockReset().mockResolvedValue({ _tag: "Success" });
  threadReads.shells.push(
    { environmentId: "work", id: "connected", title: "Parent worker", source: {} },
    {
      environmentId: "remote",
      id: "connected",
      title: "Remote child",
      source: { launchedBy: { environmentId: "work" } },
    },
    { environmentId: "denied", id: "restricted", title: "Restricted child", source: {} },
    { environmentId: "remote", id: "copied", title: "Readable copy", source: {} },
  );
  const pending = [
    {
      requestId: "approval",
      requestKind: "file-change",
      responseCapability: "live",
      createdAt: at,
    },
  ];
  threadReads.approvals.set("work\u0000connected", pending);
  threadReads.approvals.set("remote\u0000connected", pending);
  threadReads.approvals.set("remote\u0000copied", pending);
  Object.assign(screenSession, {
    supportsTaskThreads: true,
    environmentId: "main",
    threadId: "bot",
    taskChips: new Map([
      [taskId, chip],
      [offlineChip.taskId, offlineChip],
    ]),
  });
  const open = vi.fn();
  const show = (id: ChannelTaskId) => (
    <RegistryContext value={appAtomRegistry}>
      <GoatBotScreen visible taskId={id} approvalCards={MobileBotApprovals} onSelectThread={open} />
    </RegistryContext>
  );
  const view = await render(show(taskId));
  try {
    expect(view.container.textContent).toContain("6 waiting");
    const buttons = () => [...view.container.querySelectorAll("button")];
    const links = () =>
      buttons().filter((button) => button.getAttribute("aria-label")?.startsWith("Open worker"));
    expect(links().map((link) => link.getAttribute("aria-label"))).toEqual([
      "Open worker · Parent worker",
      "Open worker · studio · loading",
      "Open worker · Remote child",
    ]);
    await act(async () => links()[1]?.click());
    expect(open).toHaveBeenCalledWith({ environmentId: EnvironmentId.make("work"), id: "loading" });
    await act(async () => links()[2]?.click());
    expect(open).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("remote"),
      id: "connected",
    });
    const approve = buttons().find((button) => button.textContent === "Allow once");
    expect(approve?.disabled).toBe(true);
    await act(async () => approve?.click());
    expect(fixture.respond).not.toHaveBeenCalled();

    await act(async () => appAtomRegistry.set(canOperate, true));
    const approvalButtons = buttons().filter((button) => button.textContent === "Allow once");
    expect(approvalButtons).toHaveLength(2);
    const remoteApproval = approvalButtons.at(-1);
    expect(remoteApproval?.disabled).toBe(false);
    await act(async () => remoteApproval?.click());
    expect(fixture.respond).toHaveBeenCalledWith({
      environmentId: "remote",
      input: { threadId: "connected", requestId: "approval", decision: "accept" },
    });

    await view.rerender(show(offlineChip.taskId));
    expect(view.container.textContent).toContain("1 waiting");
    expect(links()).toHaveLength(0);
    expect(buttons().find((button) => button.textContent === "Allow once")).toBeUndefined();
  } finally {
    threadReads.approvals.clear();
    threadReads.shells.length = 0;
    await view.unmount();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["Bot Home", undefined],
  ["the task screen", taskId],
] as const)(
  "counts and links every observed worker in %s with only four approval details open",
  async (_screen, selectedTaskId) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setupTaskNavigation();
    const chips = Array.from({ length: 12 }, (_, index) =>
      decodeChip({
        ...chip,
        taskId: `task-${index}`,
        worker: { environmentId: "work", threadId: `worker-${index}`, host: "studio" },
        observed: {
          pullRequests: [],
          needsYou: [to(`worker-${index}`, "studio", "approval", "work")],
        },
      }),
    );
    for (const { worker } of chips) {
      threadReads.approvals.set(`work\u0000${worker?.threadId}`, [
        {
          requestId: "approval",
          requestKind: "file-change",
          responseCapability: "live",
          createdAt: at,
        },
      ]);
    }
    Object.assign(screenSession, {
      supportsTaskThreads: true,
      environmentId: "main",
      threadId: "bot",
      taskChips: new Map(
        selectedTaskId === undefined
          ? chips.map((entry) => [entry.taskId, entry])
          : [
              [
                selectedTaskId,
                decodeChip({
                  ...chip,
                  observed: {
                    pullRequests: [],
                    needsYou: chips.flatMap((entry) => entry.observed?.needsYou ?? []),
                  },
                }),
              ],
            ],
      ),
    });
    const view = await render(
      <RegistryContext value={appAtomRegistry}>
        <GoatBotScreen visible taskId={selectedTaskId} approvalCards={MobileBotApprovals} />
      </RegistryContext>,
    );
    try {
      expect(view.container.textContent).toContain("12 waiting");
      const buttons = [...view.container.querySelectorAll("button")];
      expect(buttons.filter((button) => button.textContent === "Allow once")).toHaveLength(4);
      expect(
        buttons.filter((button) => button.getAttribute("aria-label")?.startsWith("Open worker")),
      ).toHaveLength(12);
    } finally {
      threadReads.approvals.clear();
      await view.unmount();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["another environment", "former"],
  ["a legacy server", undefined],
] as const)(
  "keeps an approval from %s count-only when the host now points to a readable copy",
  async (_origin, destination) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setupTaskNavigation();
    appAtomRegistry.set(canOperate, true);
    threadReads.shells.push({ environmentId: "remote", id: "copied", title: "Copy", source: {} });
    threadReads.approvals.set("remote\u0000copied", [
      {
        requestId: "approval",
        requestKind: "file-change",
        responseCapability: "live",
        createdAt: at,
      },
    ]);
    Object.assign(screenSession, {
      supportsTaskThreads: true,
      environmentId: "main",
      threadId: "bot",
      taskChips: new Map([
        [
          taskId,
          decodeChip({
            ...chip,
            observed: {
              pullRequests: [],
              needsYou: [to("copied", "mini", "approval", destination)],
            },
          }),
        ],
      ]),
    });
    const view = await render(
      <RegistryContext value={appAtomRegistry}>
        <GoatBotScreen visible taskId={taskId} approvalCards={MobileBotApprovals} />
      </RegistryContext>,
    );
    try {
      expect(view.container.textContent).toContain("1 waiting");
      const buttons = [...view.container.querySelectorAll("button")];
      expect(
        buttons.some((button) => button.getAttribute("aria-label")?.startsWith("Open worker")),
      ).toBe(false);
      expect(buttons.some((button) => button.textContent === "Allow once")).toBe(false);
    } finally {
      threadReads.approvals.clear();
      threadReads.shells.length = 0;
      await view.unmount();
      vi.unstubAllGlobals();
    }
  },
);
