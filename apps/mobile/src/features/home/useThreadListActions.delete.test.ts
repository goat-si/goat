import { makeThreadShellFixture } from "../../test-fixtures";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadTitleRegenerationOutcome,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connectedEnvironmentIds: [] as EnvironmentId[],
  pendingOrder: null as object | null,
  dropBusy: false,
  failedAction: null as string | null,
  titleOutcome: null as ThreadTitleRegenerationOutcome | null,
  archivedRefreshes: [] as string[],
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  hiddenBotThreadKeys: new Set<string>() as ReadonlySet<string>,
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId: string; orderKey?: string; snoozedUntil?: string; reason?: string };
  }[],
  dialogs: [] as { onConfirm: () => Promise<boolean> }[],
  alerts: [] as {
    title: string;
    buttons?: { text: string; onPress?: () => void }[];
  }[],
  afterRequest: undefined as (() => void) | undefined,
  heldActions: new Map<string, Promise<void>>(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useInsertionEffect: (effect: () => void) => {
    effect();
  },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [
    typeof initial === "function" ? (initial as () => unknown)() : initial,
    () => {},
  ],
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
      state.alerts.push({ title, buttons }),
  },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
    state.alerts.push({ title, buttons }),
  confirm: (dialog: { onConfirm: () => Promise<boolean> }) => state.dialogs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: (environmentId: string) => {
    state.archivedRefreshes.push(environmentId);
  },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/presentation", () => ({
  connectedEnvironmentIdsAtom: "connected-environments",
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    set: (_atom: string, value: boolean) => {
      state.dropBusy = value;
    },
    get: (atom: string) =>
      atom === "connected-environments"
        ? state.connectedEnvironmentIds
        : atom === "thread-drop-busy"
          ? state.dropBusy
          : atom === "thread-shells"
            ? state.shells
            : atom === "hidden-bot-thread-keys"
              ? state.hiddenBotThreadKeys
              : atom === "queued-thread-keys"
                ? new Set<string>()
                : new Map(
                    [...state.scopes.keys()].map((environmentId) => [
                      environmentId,
                      {
                        environment: {
                          capabilities: {
                            threadSettlement: true,
                            threadSnooze: true,
                            threadPinning: true,
                            threadPinReorder: true,
                            threadActiveReorder: true,
                            threadTitleRegeneration: true,
                          },
                        },
                      },
                    ]),
                  ),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued-thread-keys" }));
const draftClear = vi.hoisted(() => vi.fn());
const draftLoad = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../state/use-composer-drafts", () => ({
  clearComposerDraft: draftClear,
  waitForComposerDraftsLoaded: draftLoad,
}));
vi.mock("../threads/goatBotThreadVisibility", () => ({
  hiddenGoatBotThreadKeysAtom: "hidden-bot-thread-keys",
}));
vi.mock("../../state/thread-order", () => ({
  threadDropBusyAtom: "thread-drop-busy",
  getPendingThreadOrder: () => state.pendingOrder,
  beginPendingThreadOrder: () => {
    state.pendingOrder = {};
    return {
      isPending: () => state.pendingOrder !== null,
      complete: () => {
        state.pendingOrder = null;
      },
      cancel: () => {
        state.pendingOrder = null;
      },
    };
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "thread-shells" },
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "snooze",
      "unsnooze",
      "pin",
      "unpin",
      "reorderPin",
      "reorderActive",
      "updateMetadata",
      "regenerateTitle",
    ].map((action) => [
      action,
      async (request: {
        environmentId: string;
        input: { threadId: string; orderKey?: string };
      }) => {
        state.requests.push({ action, ...request });
        await state.heldActions.get(action);
        if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
          return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
        }
        if (action === state.failedAction)
          return AsyncResult.failure(Cause.fail(new Error("Server rejected action")));
        state.afterRequest?.();
        return AsyncResult.success(action === "regenerateTitle" ? state.titleOutcome : undefined);
      },
    ]),
  ),
}));

import { dismissThreadUndoNotice } from "./thread-undo-notice";
import { useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    ...input,
  });
}

beforeEach(() => {
  draftClear.mockReset();
  draftLoad.mockReset();
  draftLoad.mockResolvedValue(undefined);
  state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];
  state.failedAction = null;
  state.titleOutcome = null;
  state.archivedRefreshes = [];
  state.pendingOrder = null;
  state.dropBusy = false;
  state.scopes = new Map([
    [primaryEnvironmentId, new Set([AuthOrchestrationOperateScope])],
    [otherEnvironmentId, new Set<string>()],
  ]);
  state.requests = [];
  state.shells = [];
  state.hiddenBotThreadKeys = new Set();
  state.dialogs = [];
  state.alerts = [];
  state.afterRequest = undefined;
  state.heldActions = new Map();
});

afterEach(() => {
  dismissThreadUndoNotice();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("clears only the scoped draft after a successful delete", async () => {
  useThreadListActions().confirmDeleteThread(makeThread());
  await state.dialogs[0]?.onConfirm();
  expect(draftClear).toHaveBeenCalledExactlyOnceWith("primary:thread");
});

it("keeps drafts when delete permission is denied", () => {
  state.scopes.get(primaryEnvironmentId)?.clear();
  useThreadListActions().confirmDeleteThread(makeThread());
  expect(state.dialogs).toEqual([]);
  expect(draftClear).not.toHaveBeenCalled();
});

it("keeps drafts when deletion fails", async () => {
  state.failedAction = "delete";
  useThreadListActions().confirmDeleteThread(makeThread());
  await state.dialogs[0]?.onConfirm();
  expect(draftClear).not.toHaveBeenCalled();
  expect(state.alerts).toHaveLength(1);
});

it("returns the successful deletion before a saved draft finishes loading", async () => {
  const loaded = Promise.withResolvers<void>();
  const cleared = Promise.withResolvers<void>();
  draftLoad.mockReturnValueOnce(loaded.promise);
  draftClear.mockImplementationOnce(() => cleared.resolve());
  useThreadListActions().confirmDeleteThread(makeThread());
  expect(await state.dialogs[0]?.onConfirm()).toBe(true);
  expect(draftClear).not.toHaveBeenCalled();
  loaded.resolve();
  await cleared.promise;
  expect(draftClear).toHaveBeenCalledExactlyOnceWith("primary:thread");
});

it("keeps the draft and logs when hydration never finishes", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const loaded = Promise.withResolvers<void>();
  draftLoad.mockReturnValueOnce(loaded.promise);
  useThreadListActions().confirmDeleteThread(makeThread());
  expect(await state.dialogs[0]?.onConfirm()).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(warning).toHaveBeenCalledOnce();
  loaded.resolve();
  await Promise.resolve();
  expect(draftClear).not.toHaveBeenCalled();
  warning.mockRestore();
});

it("logs hydration failures without failing deletion or clearing a draft", async () => {
  const logged = Promise.withResolvers<void>();
  const warning = vi.spyOn(console, "warn").mockImplementationOnce(() => logged.resolve());
  draftLoad.mockRejectedValueOnce(new Error("storage unavailable"));
  useThreadListActions().confirmDeleteThread(makeThread());
  expect(await state.dialogs[0]?.onConfirm()).toBe(true);
  await logged.promise;
  expect(draftClear).not.toHaveBeenCalled();
  warning.mockRestore();
});
