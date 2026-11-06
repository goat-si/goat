import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const test = vi.hoisted(() => ({
  shells: [] as unknown[],
  allowed: true,
  fork: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  open: vi.fn(),
  alert: vi.fn(),
  clear: vi.fn(),
  listeners: new Set<(threads: never[]) => void>(),
  shellStates: new Map<string, unknown>(),
  shellListeners: new Map<string, Set<(state: never) => void>>(),
  draft: { text: "/btw question", attachments: [], context: undefined },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => test.shells }));
vi.mock("../../components/ui/Dialog", () => ({ alert: test.alert }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new-id" }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => test.allowed }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    subscribe: (atom: unknown, listener: (threads: never[]) => void) => {
      if (typeof atom === "string") {
        const listeners = test.shellListeners.get(atom) ?? new Set();
        listeners.add(listener);
        test.shellListeners.set(atom, listeners);
        return () => listeners.delete(listener);
      }
      test.listeners.add(listener);
      return () => test.listeners.delete(listener);
    },
    get: (atom: unknown) =>
      typeof atom === "string"
        ? (test.shellStates.get(atom) ?? {
            generation: 0,
            snapshot: { _tag: "None" },
            removedAt: new Map(),
          })
        : test.shells,
  },
}));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: (id: string) => id } }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: {} },
  threadEnvironment: { forkAsSideChat: "fork", create: "create", startTurn: "start" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "fork" | "create" | "start") => test[name],
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => test.draft,
  clearComposerDraftContent: test.clear,
}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => test.open }));

import { useSideChatCommand } from "./useSideChatCommand";

it("creates and opens a scoped side chat, preserving a draft edited during delivery", async () => {
  test.shells = [];
  test.allowed = true;
  test.fork.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.start.mockReset().mockImplementation(async () => {
    test.draft.text = "newer draft";
    return { _tag: "Success" };
  });
  test.open.mockReset();
  test.clear.mockReset();
  test.draft = { text: "/btw question", attachments: [], context: undefined };
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "parent",
    environmentId: "env",
    projectId: "project",
    title: "Task",
    latestRun: {},
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  await act(async () => {
    await send?.({
      thread,
      threadKey: "env:parent",
      text: "/btw question",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "env",
      input: expect.objectContaining({ sourceThreadId: "parent", targetThreadId: "new-id" }),
    }),
  );
  expect(test.start).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "env",
      input: expect.objectContaining({
        threadId: "new-id",
        runtimeMode: "approval-required",
        message: expect.objectContaining({ text: "question" }),
      }),
    }),
  );
  expect(test.clear).not.toHaveBeenCalled();
  expect(test.open).toHaveBeenCalledWith({ environmentId: "env", threadId: "new-id" });
  await act(async () => root.unmount());
});

it("does not create or send when the environment scope is missing", async () => {
  test.allowed = false;
  test.fork.mockReset();
  test.create.mockReset();
  test.start.mockReset();
  test.alert.mockReset();
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await send?.({
      thread: { environmentId: "env" } as never,
      threadKey: "env:parent",
      text: "/side hello",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).not.toHaveBeenCalled();
  expect(test.create).not.toHaveBeenCalled();
  expect(test.start).not.toHaveBeenCalled();
  expect(test.alert).toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("reuses an existing side chat and keeps the draft when sending fails", async () => {
  test.allowed = true;
  test.shells = [
    {
      id: "existing",
      environmentId: "env",
      sideChatOf: "parent",
      archivedAt: null,
      deletedAt: null,
      createdAt: "2026-01-01",
    },
  ];
  test.fork.mockReset();
  test.create.mockReset();
  test.start.mockReset().mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
  test.open.mockReset();
  test.clear.mockReset();
  test.alert.mockReset();
  test.draft = { text: "/side question", attachments: [], context: undefined };
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "parent",
    environmentId: "env",
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  await act(async () => {
    await send?.({
      thread,
      threadKey: "env:parent",
      text: "/side question",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).not.toHaveBeenCalled();
  expect(test.create).not.toHaveBeenCalled();
  expect(test.start).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ threadId: "existing" }) }),
  );
  expect(test.clear).not.toHaveBeenCalled();
  expect(test.open).toHaveBeenCalledWith({ environmentId: "env", threadId: "existing" });
  await act(async () => root.unmount());
});

it("reuses a newly created side chat before its shell reaches this device", async () => {
  test.allowed = true;
  test.shells = [];
  test.fork.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.start.mockReset().mockResolvedValue({ _tag: "Success" });
  test.open.mockReset();
  test.clear.mockReset();
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "parent-race",
    environmentId: "env-race",
    projectId: "project",
    title: "Task",
    latestRun: {},
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  await act(async () => {
    await send?.({
      thread,
      threadKey: "env-race:parent-race",
      text: "/side one",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  await act(async () => root.unmount());
  const reopened = createRoot(document.createElement("div"));
  await act(async () => reopened.render(<Harness />));
  await act(async () => {
    await send?.({
      thread,
      threadKey: "env-race:parent-race",
      text: "/side two",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).toHaveBeenCalledTimes(1);
  expect(test.create).not.toHaveBeenCalled();
  expect(test.start).toHaveBeenCalledTimes(2);
  expect(test.start).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      environmentId: "env-race",
      input: expect.objectContaining({
        threadId: "new-id",
        message: expect.objectContaining({ text: "two" }),
      }),
    }),
  );
  test.shells = [
    {
      id: "new-id",
      environmentId: "env-race",
      sideChatOf: "parent-race",
      archivedAt: null,
      deletedAt: null,
      createdAt: "2026-01-01",
    },
  ];
  for (const listener of test.listeners) listener(test.shells as never[]);
  test.shells = [];
  await act(async () => {
    await send?.({
      thread,
      threadKey: "env-race:parent-race",
      text: "/side three",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).toHaveBeenCalledTimes(2);
  await act(async () => reopened.unmount());
});

it("does not reuse a pending side chat from another environment", async () => {
  test.allowed = true;
  test.shells = [];
  test.fork.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.start.mockReset().mockResolvedValue({ _tag: "Success" });
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const source = {
    id: "same-parent",
    projectId: "project",
    title: "Task",
    latestRun: {},
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  };
  await act(async () => {
    await send?.({
      thread: { ...source, environmentId: "scope-one" } as never,
      threadKey: "scope-one:same-parent",
      text: "/side one",
      connected: true,
      hasAttachmentsOrContext: false,
    });
    await send?.({
      thread: { ...source, environmentId: "scope-two" } as never,
      threadKey: "scope-two:same-parent",
      text: "/side two",
      connected: true,
      hasAttachmentsOrContext: false,
    });
  });
  expect(test.fork).toHaveBeenCalledTimes(2);
  expect(test.fork).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ environmentId: "scope-two" }),
  );
  await act(async () => root.unmount());
});

it("does not start two forks for the same parent from separate mounted views", async () => {
  test.allowed = true;
  test.shells = [];
  test.alert.mockReset();
  const forkResult = Promise.withResolvers<{ _tag: "Success"; value: { sequence: number } }>();
  test.fork.mockReset().mockReturnValue(forkResult.promise);
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.start.mockReset().mockResolvedValue({ _tag: "Success" });
  let first: ReturnType<typeof useSideChatCommand> | undefined;
  let second: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const firstCommand = useSideChatCommand();
    const secondCommand = useSideChatCommand();
    useLayoutEffect(() => {
      first = firstCommand;
      second = secondCommand;
    }, [firstCommand, secondCommand]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "concurrent-parent",
    environmentId: "concurrent-env",
    projectId: "project",
    title: "Task",
    latestRun: {},
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  const input = {
    thread,
    threadKey: "concurrent-env:concurrent-parent",
    text: "/side question",
    connected: true,
    hasAttachmentsOrContext: false,
  };
  let pending: Promise<boolean> | undefined;
  await act(async () => {
    pending = first?.(input);
    await second?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(1);
  expect(test.alert).toHaveBeenCalled();
  await act(async () => {
    forkResult.resolve({ _tag: "Success", value: { sequence: 10 } });
    await pending;
  });
  expect(test.start).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("forgets a side chat deleted before the next authoritative shell snapshot", async () => {
  test.allowed = true;
  test.shells = [];
  test.fork
    .mockReset()
    .mockResolvedValueOnce({ _tag: "Success", value: { sequence: 10 } })
    .mockResolvedValueOnce({ _tag: "Success", value: { sequence: 12 } })
    .mockResolvedValue({ _tag: "Success", value: { sequence: 14 } });
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
  test.start.mockReset().mockResolvedValue({ _tag: "Success" });
  test.shellStates.set("deleted-env", {
    generation: 1,
    snapshot: { _tag: "Some", value: { snapshotSequence: 8, threads: [] } },
    removedAt: new Map(),
  });
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "deleted-parent",
    environmentId: "deleted-env",
    projectId: "project",
    title: "Task",
    latestRun: {},
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  const input = {
    thread,
    threadKey: "deleted-env:deleted-parent",
    text: "/side question",
    connected: true,
    hasAttachmentsOrContext: false,
  };
  await act(async () => {
    await send?.(input);
  });
  const stale = {
    generation: 2,
    snapshot: { _tag: "Some", value: { snapshotSequence: 9, threads: [] } },
    removedAt: new Map(),
  };
  test.shellStates.set("deleted-env", stale);
  for (const listener of test.shellListeners.get("deleted-env") ?? []) listener(stale as never);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(1);
  const laterDelta = {
    ...stale,
    snapshot: { _tag: "Some", value: { snapshotSequence: 11, threads: [] } },
  };
  test.shellStates.set("deleted-env", laterDelta);
  for (const listener of test.shellListeners.get("deleted-env") ?? [])
    listener(laterDelta as never);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(1);
  const afterDeletion = {
    generation: 3,
    snapshot: { _tag: "Some", value: { snapshotSequence: 11, threads: [] } },
    removedAt: new Map(),
  };
  test.shellStates.set("deleted-env", afterDeletion);
  for (const listener of test.shellListeners.get("deleted-env") ?? [])
    listener(afterDeletion as never);
  expect(test.shellListeners.get("deleted-env")?.size).toBe(0);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(2);
  const oldRemoval = { ...afterDeletion, removedAt: new Map([["new-id", 9]]) };
  test.shellStates.set("deleted-env", oldRemoval);
  for (const listener of test.shellListeners.get("deleted-env") ?? [])
    listener(oldRemoval as never);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(2);
  const removal = { ...afterDeletion, removedAt: new Map([["new-id", 13]]) };
  test.shellStates.set("deleted-env", removal);
  for (const listener of test.shellListeners.get("deleted-env") ?? []) listener(removal as never);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).toHaveBeenCalledTimes(3);
  await act(async () => root.unmount());
});

it("expires an unforked side chat after a later removal", async () => {
  test.allowed = true;
  test.shells = [];
  test.fork.mockReset();
  test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 20 } });
  test.start.mockReset().mockResolvedValue({ _tag: "Success" });
  test.shellStates.set("empty-env", {
    generation: 1,
    snapshot: { _tag: "Some", value: { snapshotSequence: 19, threads: [] } },
    removedAt: new Map(),
  });
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    const command = useSideChatCommand();
    useLayoutEffect(() => {
      send = command;
    }, [command]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const thread = {
    id: "empty-parent",
    environmentId: "empty-env",
    projectId: "project",
    title: "Task",
    latestRun: null,
    runtimeMode: "approval-required",
    lineage: { relationshipToParent: "fork" },
    sideChatOf: null,
  } as never;
  const input = {
    thread,
    threadKey: "empty-env:empty-parent",
    text: "/side question",
    connected: true,
    hasAttachmentsOrContext: false,
  };
  await act(async () => {
    await send?.(input);
  });
  const removed = {
    generation: 1,
    snapshot: { _tag: "Some", value: { snapshotSequence: 21, threads: [] } },
    removedAt: new Map([["new-id", 21]]),
  };
  test.shellStates.set("empty-env", removed);
  for (const listener of test.shellListeners.get("empty-env") ?? []) listener(removed as never);
  await act(async () => {
    await send?.(input);
  });
  expect(test.fork).not.toHaveBeenCalled();
  expect(test.create).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it.each([false, true])(
  "reconciles a snapshot received before registration (target present: %s)",
  async (present) => {
    test.allowed = true;
    test.shells = [];
    const environmentId = `early-snapshot-${present}`;
    test.shellStates.set(environmentId, {
      generation: 1,
      snapshot: { _tag: "Some", value: { snapshotSequence: 8, threads: [] } },
      removedAt: new Map(),
    });
    test.fork.mockReset().mockImplementation(async () => {
      test.shellStates.set(environmentId, {
        generation: 2,
        snapshot: {
          _tag: "Some",
          value: { snapshotSequence: 11, threads: present ? [{ id: "new-id" }] : [] },
        },
        removedAt: new Map(),
      });
      return { _tag: "Success", value: { sequence: 10 } };
    });
    test.create.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 10 } });
    test.start.mockReset().mockResolvedValue({ _tag: "Success" });
    let send: ReturnType<typeof useSideChatCommand> | undefined;
    function Harness() {
      const command = useSideChatCommand();
      useLayoutEffect(() => {
        send = command;
      }, [command]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    const thread = {
      id: "early-parent",
      environmentId,
      projectId: "project",
      title: "Task",
      latestRun: {},
      runtimeMode: "approval-required",
      lineage: { relationshipToParent: "fork" },
      sideChatOf: null,
    } as never;
    const input = {
      thread,
      threadKey: `${environmentId}:early-parent`,
      text: "/side question",
      connected: true,
      hasAttachmentsOrContext: false,
    };
    await act(async () => {
      await send?.(input);
    });
    await act(async () => {
      await send?.(input);
    });
    expect(test.fork).toHaveBeenCalledTimes(present ? 1 : 2);
    expect(test.shellListeners.get(environmentId)?.size ?? 0).toBe(present ? 1 : 0);
    await act(async () => root.unmount());
  },
);
