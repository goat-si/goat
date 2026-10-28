import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  resolveGoatBotHomeSelection,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import {
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ProjectId,
  RunId,
  ThreadId,
  type ChannelBotRef,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: null as ChannelBotRef | null,
  loaded: true,
  run: vi.fn(),
  save: vi.fn(),
  items: [] as ReadonlyArray<unknown>,
  workerShell: null as object | null,
  shellReads: [] as Array<string | null>,
}));
const connection = AsyncResult.success({ phase: "connected", generation: 1 });
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) =>
    atom === permissionAtom ? true : atom === connectionAtom ? connection : null,
  useAtomSet: () => harness.save,
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  runAtomCommand: harness.run,
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => connectionAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return registry;
  },
}));
// One stand-in detail atom for every worker ref, so a test can play the screen that loads it.
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => detailAtom },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    ensureBot: { permissionAtom: () => permissionAtom },
    ingest: { permissionAtom: () => permissionAtom },
  },
}));
vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => harness.items,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => {
    harness.shellReads.push(ref?.threadId ?? null);
    return ref?.threadId === "worker-1" && harness.workerShell !== null
      ? { source: harness.workerShell }
      : null;
  },
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ status: "loading" }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request" }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    ...harness,
    home: resolveGoatBotHomeSelection(harness.environments, harness.botRef),
  }),
}));
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";

const permissionAtom = Atom.make(true);
const connectionAtom = Atom.make(connection);
const detailAtom = Atom.make<unknown>(null);
const registry = Object.assign(AtomRegistry.make(), { get: () => connection });
let root: Root | null = null;
let session: ReturnType<typeof useMobileGoatBotSession>;
function Consumer() {
  const value = useMobileGoatBotSession(true);
  useLayoutEffect(() => {
    session = value;
  }, [value]);
  return null;
}
async function render() {
  root ??= createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(<Consumer />);
  });
}
function environment(id: string, connected = true): GoatBotEnvironmentInput {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connected,
    primary: false,
    supportsChannelLedger: true,
  };
}
function bot(environmentId: EnvironmentId): ChannelBotRef {
  return { environmentId, projectId: ProjectId.make("project"), threadId: ThreadId.make("bot") };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [];
  harness.botRef = null;
  harness.loaded = true;
  harness.save.mockReset();
  harness.run.mockReset().mockImplementation(async (_registry, _command, { environmentId }) => ({
    _tag: "Success",
    value: bot(environmentId),
  }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("mobile GOAT Bot session selection", () => {
  it("keeps a missing legacy stored bot offline without ensuring on another server", async () => {
    harness.botRef = bot(EnvironmentId.make("missing-A"));
    harness.environments = [environment("missing-B")];
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(session.availability).toBe("offline");
  });
  it("keeps a disconnected legacy stored bot offline without replacing its reference", async () => {
    harness.botRef = bot(EnvironmentId.make("offline-A"));
    harness.environments = [environment("offline-A", false), environment("offline-B")];
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(session.availability).toBe("offline");
  });
  it("ensures on connected B when legacy A is offline and no bot is stored", async () => {
    harness.environments = [environment("new-A", false), environment("new-B")];
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: bot(EnvironmentId.make("new-B")) });
    expect(session.availability).toBe("ready");
  });
  it("does not ensure until delayed preferences identify stored B", async () => {
    harness.environments = [environment("loading-A"), environment("loading-B")];
    harness.loaded = false;
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    harness.loaded = true;
    harness.botRef = bot(EnvironmentId.make("loading-B"));
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: harness.botRef });
  });
  it("uses the shared claimed home B even when the stored bot belongs to A", async () => {
    const b = EnvironmentId.make("home-B");
    const claim = { environmentId: b, claimedAt: 1, claimId: "claim" };
    harness.botRef = bot(EnvironmentId.make("home-A"));
    harness.environments = [environment("home-A"), environment("home-B")].map((entry) => ({
      ...entry,
      homeTarget: {
        environmentId: entry.environmentId,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: claim,
      },
    }));
    await render();
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.save).toHaveBeenCalledWith({ goatBotRef: bot(b) });
    expect(session.availability).toBe("ready");
  });
});

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = "2026-10-28T12:00:00.000Z";
function conversation(worker: object): OrchestrationV2ProjectedTurnItem[] {
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
  return [
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
        summary: "Copying files",
        worker,
        openQuestionCount: 0,
      },
    },
  ].map((json, position) => {
    const item = decodeItem(json);
    return {
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    };
  });
}
const detail = (status: "running" | "completed") => ({
  environmentId: "env",
  projection: {
    runs: [],
    nodes: [],
    runtimeRequests: [],
    turnItems: [
      {
        type: "command_execution",
        runId: RunId.make("run-1"),
        status,
        title: "Run df -h",
        updatedAt: DateTime.makeUnsafe(at),
      },
    ],
  },
});

describe("mobile GOAT Bot activity", () => {
  function setup(worker: object) {
    harness.items = conversation(worker);
    harness.workerShell = { activityRunStatus: "preparing", pendingRuntimeRequest: null };
    harness.shellReads.length = 0;
  }

  it("follows the acknowledged worker's shell without loading its detail", async () => {
    setup({ environmentId: "env", threadId: "worker-1" });
    await render();
    expect(session.activity).toEqual({ state: "working", text: "Copying files" });
    expect(harness.shellReads).toContain("worker-1");
    expect(registry.getNodes().has(detailAtom)).toBe(false);
  });

  it("follows a detail-only change while another screen keeps the worker loaded", async () => {
    setup({ environmentId: "env", threadId: "worker-1" });
    registry.set(detailAtom, detail("running"));
    const unmountOtherScreen = registry.mount(detailAtom);
    try {
      await render();
      expect(session.activity?.text).toBe("Run df -h");
      await act(async () => registry.set(detailAtom, detail("completed")));
      expect(session.activity?.text).toBe("Copying files");
    } finally {
      unmountOtherScreen();
    }
  });

  it("never reads a remote worker through a local thread with the same id", async () => {
    setup({ environmentId: "env", threadId: "worker-1", host: "mac-studio" });
    registry.set(detailAtom, detail("running"));
    const unmountOtherScreen = registry.mount(detailAtom);
    try {
      await render();
      expect(session.activity?.text).toBe("Copying files");
      expect(harness.shellReads).not.toContain("worker-1");
    } finally {
      unmountOtherScreen();
    }
  });
});
