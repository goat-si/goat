import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@goat/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const state = vi.hoisted(() => ({
  draftText: "Keep this draft separate",
  cleanups: [] as Array<() => void>,
  delivery: null as {
    readonly drain: () => void;
    readonly dispose: () => void;
  } | null,
  start: vi.fn(),
  metadata: vi.fn(),
  runtime: vi.fn(),
  interaction: vi.fn(),
  prepare: vi.fn(),
  checkout: vi.fn(),
  modelUnavailable: vi.fn(() => false),
  familyMount: vi.fn(() => () => {}),
  threadShells: null as unknown as Atom.Writable<ReadonlyArray<unknown>>,
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  thread: {
    environmentId: "secondary",
    id: "thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
  },
  config: {
    shellThreadFamilies: false,
    providers: [{ instanceId: "codex", driver: "codex", models: [] }],
    environment: { capabilities: {} },
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: (input: unknown) => unknown, input: unknown) =>
    command(input),
}));
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  // A session's state is reduced to whether it grants the operate scope.
  const sessionStateAtom = Atom.family((_id: string) => Atom.make(false).pipe(Atom.keepAlive));
  const sessionHasScope = (granted: boolean, scope: string) =>
    granted && scope === AuthOrchestrationOperateScope;
  return {
    environmentSession: { sessionStateAtom },
    sessionHasScope,
    readEnvironmentScope: (environmentId: string, scope: string) =>
      sessionHasScope(appAtomRegistry.get(sessionStateAtom(environmentId)), scope),
  };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});
vi.mock("./workspace", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    workspaceConnections: {
      environmentsAtom: Atom.make([{ environmentId: "secondary", connectionState: "connected" }]),
    },
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
    environmentServerConfigsAtom: Atom.make(new Map([["secondary", state.config]])),
  };
});
vi.mock("./threads", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  state.threadShells = Atom.make<ReadonlyArray<unknown>>([state.thread]).pipe(Atom.keepAlive);
  return {
    threadEnvironment: {
      startTurn: state.start,
      updateMetadata: state.metadata,
      setRuntimeMode: state.runtime,
      setInteractionMode: state.interaction,
    },
    environmentThreadShells: { threadShellsAtom: state.threadShells },
    threadFamilies: {
      mount: state.familyMount,
      familyAtom: () => Atom.make(AsyncResult.success({})),
      refresh: vi.fn(),
    },
    environmentThreadDetails: { stateAtom: () => Atom.make(null) },
  };
});
vi.mock("./git", () => ({ gitEnvironment: { preparePullRequestThread: state.checkout } }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: state.modelUnavailable }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => {},
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    retryingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    threadOutboxShellStatusesAtom: Atom.make(new Map([["secondary", "live"]])),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(),
    getComposerDraftSnapshot: vi.fn(() => ({ text: state.draftText, attachments: [] })),
    mergeComposerDraftContent: vi.fn(async (_key: string, input: { text: string }) => {
      state.draftText += `\n${input.text}`;
    }),
    replaceComposerDraftAttachments: vi.fn(),
    undoComposerDraftMerge: vi.fn(),
    updateComposerDraftSettings: vi.fn(),
    waitForComposerDraftsLoaded: vi.fn(),
  };
});

import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";
import { dispatchingQueuedMessageIdAtom, editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import { createThreadOutboxDelivery } from "./threadOutboxDelivery";
import { queuedMessageWaitReasonsAtom } from "./threadOutboxWaitReasons";

const message = (overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Keep this queued",
  attachments: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});
const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function setOperateGrant(environmentId: string, granted: boolean): void {
  // The mocked session atom holds the grant itself (see the ./session mock).
  const sessionAtom = environmentSession.sessionStateAtom(EnvironmentId.make(environmentId));
  appAtomRegistry.set(sessionAtom as unknown as Atom.Writable<boolean>, granted);
}

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
    if (id === null) settled.resolve();
  });
  startDelivery();
  return settled.promise.finally(release);
}

/** Starts the service once per test; later calls run another drain pass. */
function startDelivery(): void {
  if (state.delivery !== null) {
    state.delivery.drain();
    return;
  }
  const delivery = createThreadOutboxDelivery();
  state.delivery = delivery;
  state.cleanups.push(() => {
    delivery.dispose();
    state.delivery = null;
  });
}

beforeEach(() => {
  setOperateGrant("primary", true);
  setOperateGrant("secondary", false);
  state.draftText = "Keep this draft separate";
  state.config.shellThreadFamilies = false;
  state.modelUnavailable.mockReset().mockReturnValue(false);
  state.familyMount.mockReset().mockReturnValue(() => {});
  appAtomRegistry.set(state.threadShells, [state.thread]);
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  for (const command of [
    state.start,
    state.metadata,
    state.runtime,
    state.interaction,
    state.checkout,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.start.mockResolvedValue(AsyncResult.success({}));
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
});

afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

it("releases a removed thread's delivery slot for a newly queued message", async () => {
  setOperateGrant("secondary", true);
  const first = message();
  await state.manager.enqueue(first);
  const upload = Promise.withResolvers<{
    status: "ready";
    attachments: [];
    draftAttachments: [];
    pendingAttachmentIds: [];
  }>();
  state.prepare.mockImplementationOnce(() => upload.promise);
  startDelivery();
  try {
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
    await state.manager.remove(first);
    await state.manager.enqueue(
      message({
        messageId: MessageId.make("replacement-message"),
        commandId: CommandId.make("replacement-command"),
      }),
    );
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
    expect(state.start.mock.calls[0]?.[0].input.message.messageId).toBe("replacement-message");
  } finally {
    upload.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: [],
      pendingAttachmentIds: [],
    });
  }
});

it("prevents editing either message while two threads are delivering", async () => {
  const { editPendingThreadMessage } = await import("./edit-pending-thread-message");
  setOperateGrant("secondary", true);
  const first = message();
  const second = message({
    threadId: ThreadId.make("other-thread"),
    messageId: MessageId.make("other-message"),
    commandId: CommandId.make("other-command"),
  });
  appAtomRegistry.set(state.threadShells, [state.thread, { ...state.thread, id: "other-thread" }]);
  await state.manager.enqueue(first);
  await state.manager.enqueue(second);
  const upload = Promise.withResolvers<{
    status: "ready";
    attachments: [];
    draftAttachments: [];
    pendingAttachmentIds: [];
  }>();
  state.prepare.mockReturnValue(upload.promise);
  startDelivery();
  try {
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(2));
    expect(await editPendingThreadMessage(first)).toBe(false);
    expect(await editPendingThreadMessage(second)).toBe(false);
  } finally {
    upload.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: [],
      pendingAttachmentIds: [],
    });
  }
});

it("delivers same-thread messages in order after the first upload finishes", async () => {
  setOperateGrant("secondary", true);
  const first = message();
  const second = message({
    messageId: MessageId.make("second-message"),
    commandId: CommandId.make("second-command"),
  });
  await state.manager.enqueue(first);
  await state.manager.enqueue(second);
  const upload = Promise.withResolvers<{
    status: "ready";
    attachments: [];
    draftAttachments: [];
    pendingAttachmentIds: [];
  }>();
  state.prepare.mockImplementationOnce(() => upload.promise);
  startDelivery();
  try {
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
    expect(state.start).not.toHaveBeenCalled();
    upload.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: [],
      pendingAttachmentIds: [],
    });
    await vi.waitFor(() => expect(state.start).toHaveBeenCalledTimes(2));
    expect(state.start.mock.calls.map((call) => call[0].input.message.messageId)).toEqual([
      first.messageId,
      second.messageId,
    ]);
  } finally {
    upload.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: [],
      pendingAttachmentIds: [],
    });
  }
});

describe("upload retry budget across deferrals", () => {
  it("keeps its retry budget when a removed environment is added again", async () => {
    const { workspaceConnections } = await import("./workspace");
    const environments = workspaceConnections.environmentsAtom as unknown as Atom.Writable<
      ReadonlyArray<{ environmentId: string; connectionState: string }>
    >;
    const connected = [{ environmentId: "secondary", connectionState: "connected" }];
    state.cleanups.push(() => appAtomRegistry.set(environments, connected));
    setOperateGrant("secondary", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.cleanups.push(() => vi.useRealTimers());
    const queued = message();
    await state.manager.enqueue(queued);
    state.prepare.mockRejectedValue(new Error("Socket is not connected"));
    await runDrain();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.prepare).toHaveBeenCalledTimes(4);
    appAtomRegistry.set(environments, [
      { environmentId: "secondary", connectionState: "disconnected" },
    ]);
    appAtomRegistry.set(environments, []);
    appAtomRegistry.set(environments, connected);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.prepare).toHaveBeenCalledTimes(5);
    expect(remaining()).toEqual([queued]);
    expect(appAtomRegistry.get(queuedMessageWaitReasonsAtom)[queued.messageId]).toBeDefined();
  });

  it.each(["missing", "editor"] as const)(
    "keeps failed upload attempts across a %s deferral",
    async (kind) => {
      setOperateGrant("secondary", true);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      state.cleanups.push(() => vi.useRealTimers());
      const queued = message();
      await state.manager.enqueue(queued);
      state.prepare.mockRejectedValue(new Error("Socket is not connected"));
      await runDrain();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(state.prepare).toHaveBeenCalledTimes(4);
      const gate = Promise.withResolvers<boolean>();
      const started = Promise.withResolvers<void>();
      const confirm = vi.spyOn(state.manager, "confirmQueued").mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      vi.advanceTimersByTime(8_000);
      await started.promise;
      const { threadOutboxShellStatusesAtom } = await import("./use-thread-outbox");
      const statuses = threadOutboxShellStatusesAtom as unknown as Atom.Writable<
        Map<string, string>
      >;
      if (kind === "editor") {
        appAtomRegistry.set(editingQueuedMessageIdsAtom, { [queued.messageId]: true });
      } else {
        appAtomRegistry.set(statuses, new Map([["secondary", "syncing"]]));
        appAtomRegistry.set(state.threadShells, []);
      }
      const settled = Promise.withResolvers<void>();
      const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
        if (id === null) settled.resolve();
      });
      gate.resolve(true);
      await settled.promise.finally(release);
      expect(state.prepare).toHaveBeenCalledTimes(4);
      confirm.mockRestore();
      if (kind === "editor") appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
      else {
        appAtomRegistry.set(state.threadShells, [state.thread]);
        appAtomRegistry.set(statuses, new Map([["secondary", "live"]]));
      }
      await vi.advanceTimersByTimeAsync(120_000);
      expect(state.prepare).toHaveBeenCalledTimes(5);
      expect(remaining()).toEqual([queued]);
      expect(appAtomRegistry.get(queuedMessageWaitReasonsAtom)[queued.messageId]).toBeDefined();
    },
  );

  it("does not reset the upload budget when only the server config disappears", async () => {
    const { environmentServerConfigsAtom } = await import("./server");
    setOperateGrant("secondary", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    state.cleanups.push(() => vi.useRealTimers());
    const configs = environmentServerConfigsAtom as unknown as Atom.Writable<
      Map<string, typeof state.config>
    >;
    state.cleanups.push(() => appAtomRegistry.set(configs, new Map([["secondary", state.config]])));
    const queued = message();
    await state.manager.enqueue(queued);
    state.prepare.mockRejectedValue(new Error("Socket is not connected"));
    await runDrain();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.prepare).toHaveBeenCalledTimes(4);
    appAtomRegistry.set(configs, new Map());
    appAtomRegistry.set(configs, new Map([["secondary", state.config]]));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.prepare).toHaveBeenCalledTimes(5);
    expect(remaining()).toEqual([queued]);
  });
});

it("delivers to a busy thread and clears its prior upload-failure count", async () => {
  setOperateGrant("secondary", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  state.cleanups.push(() => vi.useRealTimers());
  const queued = message();
  await state.manager.enqueue(queued);
  state.prepare.mockRejectedValue(new Error("Socket is not connected"));
  await runDrain();
  await vi.advanceTimersByTimeAsync(7_000);
  expect(state.prepare).toHaveBeenCalledTimes(4);
  state.prepare.mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
  appAtomRegistry.set(state.threadShells, [{ ...state.thread, runtime: { status: "running" } }]);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(state.start).toHaveBeenCalledOnce();
  expect(remaining()).toEqual([]);
  state.prepare.mockRejectedValue(new Error("Socket is not connected"));
  await state.manager.enqueue(queued);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(state.prepare).toHaveBeenCalledTimes(10);
  expect(remaining()).toEqual([queued]);
  expect(appAtomRegistry.get(queuedMessageWaitReasonsAtom)[queued.messageId]).toBeDefined();
});
