import "./goatBotScreenTestHarness";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ChannelTaskChip,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
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
const canOperate = Atom.make(false);
const presentations = vi.hoisted(
  () =>
    new Map([
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
const to = (worker: string, host = "studio", requestId = "approval") => ({
  kind: "approval",
  since: at,
  approval: {
    requestId,
    threadId: worker,
    host,
  },
});
const chip = Schema.decodeUnknownSync(ChannelTaskChip)({
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
      to("connected"),
      to("loading"),
      to("connected", "mini"),
      to("connected", "mini", "second-approval"),
      to("unavailable", "unknown"),
      to("restricted", "restricted-host"),
    ],
  },
});
const offlineChip = Schema.decodeUnknownSync(ChannelTaskChip)({
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
    expect(view.container.textContent).toContain("5 waiting");
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
    const remoteApproval = buttons()
      .filter((button) => button.textContent === "Allow once")
      .at(-1);
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
