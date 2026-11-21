import "./goatBotScreenTestHarness";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ChannelTaskChip,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
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
  operate: false,
  respond: vi.fn(),
}));
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
      presentationAtom: Atom.family((id: string) =>
        Atom.make({ connection: { phase: id === "offline" ? "disconnected" : "connected" } }),
      ),
    },
  };
});
vi.mock("../../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    useEnvironmentScope: () => fixture.operate,
    sessionHasScope: () => true,
    readEnvironmentScope: (_id: string, scope: string) => scope === AuthOrchestrationReadScope,
    environmentSession: { sessionStateAtom: () => Atom.make(null) },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixture.respond }));
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
const to = (worker: string) => ({
  kind: "approval",
  since: at,
  approval: {
    requestId: "approval",
    threadId: worker,
    host: worker === "unrelated" ? "other" : "studio",
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
  observed: { pullRequests: [], needsYou: ["connected", "loading", "unrelated"].map(to) },
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
  fixture.operate = false;
  fixture.respond.mockReset();
  threadReads.approvals.set("connected", [
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
    expect(view.container.textContent).toContain("2 waiting");
    const buttons = () => [...view.container.querySelectorAll("button")];
    const links = () =>
      buttons().filter((button) => button.getAttribute("aria-label")?.startsWith("Open worker"));
    expect(links()).toHaveLength(2);
    await act(async () => links()[1]?.click());
    expect(open).toHaveBeenCalledWith({ environmentId: EnvironmentId.make("work"), id: "loading" });
    const approve = buttons().find((button) => button.textContent === "Allow once");
    expect(approve?.disabled).toBe(true);
    await act(async () => approve?.click());
    expect(fixture.respond).not.toHaveBeenCalled();

    await view.rerender(show(offlineChip.taskId));
    expect(view.container.textContent).toContain("1 waiting");
    expect(links()).toHaveLength(0);
    expect(buttons().find((button) => button.textContent === "Allow once")).toBeUndefined();
  } finally {
    threadReads.approvals.clear();
    await view.unmount();
    vi.unstubAllGlobals();
  }
});
