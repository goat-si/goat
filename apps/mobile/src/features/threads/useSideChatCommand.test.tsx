import { act } from "react";
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
  draft: { text: "/btw question", attachments: [], context: undefined },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => test.shells }));
vi.mock("../../components/ui/Dialog", () => ({ alert: test.alert }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new-id" }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => test.allowed }));
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
  test.fork.mockReset().mockResolvedValue({ _tag: "Success" });
  test.create.mockReset().mockResolvedValue({ _tag: "Success" });
  test.start.mockReset().mockImplementation(async () => {
    test.draft.text = "newer draft";
    return { _tag: "Success" };
  });
  test.open.mockReset();
  test.clear.mockReset();
  test.draft = { text: "/btw question", attachments: [], context: undefined };
  let send: ReturnType<typeof useSideChatCommand> | undefined;
  function Harness() {
    send = useSideChatCommand();
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
    send = useSideChatCommand();
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
    send = useSideChatCommand();
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
