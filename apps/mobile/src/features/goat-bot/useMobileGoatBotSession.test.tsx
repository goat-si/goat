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
import * as Option from "effect/Option";
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
  upload: vi.fn(),
  verify: vi.fn(),
  release: vi.fn(async (_attachments: ReadonlyArray<unknown>) => {}),
  key: vi.fn(() => "request"),
}));
const preparedConnection = Symbol("prepared connection");
vi.mock("@goat/client-runtime/state/attachments", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: harness.upload,
  verifyPersistedAttachmentUpload: harness.verify,
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: {}, remove: {} },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  environmentSession: { preparedConnectionValueAtom: () => preparedConnection },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: harness.release,
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
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ status: "loading" }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => harness.key() }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    ...harness,
    home: resolveGoatBotHomeSelection(harness.environments, harness.botRef),
  }),
}));
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";
import * as botSessions from "./useMobileGoatBotSession";
import * as fileOwnership from "../../lib/composerAttachmentFiles";

const permissionAtom = Atom.make(true);
const connectionAtom = Atom.make(connection);
const detailAtom = Atom.make<unknown>(null);
const registry = Object.assign(AtomRegistry.make(), {
  get: (atom: unknown) =>
    atom === preparedConnection ? Option.some({ httpBaseUrl: "https://example.test" }) : connection,
});
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
  harness.release.mockReset().mockResolvedValue(undefined);
  harness.key.mockReset().mockReturnValue("request");
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
  it("waits for an in-flight upload and its pending upload deletion when the environment is removed", async () => {
    const env = EnvironmentId.make("remove-in-flight-upload");
    const uploadId = "pending-00000000-0000-4000-8000-000000000001-pdf";
    const file = {
      id: "in-flight",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/in-flight.pdf",
    };
    harness.environments = [environment(env)];
    harness.items = [];
    const started = Promise.withResolvers<void>();
    const transfer = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    const finishDelete = Promise.withResolvers<void>();
    harness.upload.mockReset().mockImplementation(async (input) => {
      expect(input.onMinted(uploadId)).toBe("continue");
      started.resolve();
      await transfer.promise;
      return { status: "uploaded", attachmentId: uploadId };
    });
    const ingests: unknown[] = [];
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if ("input" in args && "attachmentId" in args.input) {
        expect(args.input.attachmentId).toBe(uploadId);
        deleted.resolve();
        await finishDelete.promise;
        return { _tag: "Success", value: undefined };
      }
      if ("input" in args && "idempotencyKey" in args.input) ingests.push(args.input);
      return { _tag: "Success", value: bot(env) };
    });
    await render();
    await act(async () => {
      expect(session.onSend("hello", [file])).toBe(true);
      await started.promise;
    });
    let settled = false;
    let removal!: Promise<void>;
    await act(async () => {
      removal = botSessions.disposeMobileGoatBotEnvironment(env).then(() => {
        settled = true;
      });
      await Promise.resolve();
    });
    try {
      expect(settled).toBe(false);
      expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(true);
      expect(harness.release).not.toHaveBeenCalled();
    } finally {
      transfer.resolve();
    }
    await deleted.promise;
    expect(settled).toBe(false);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(true);
    finishDelete.resolve();
    await act(async () => {
      await removal;
    });
    expect(ingests).toEqual([]);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(false);
  });
  it("keeps a shared upload available for another failed message after discard (#2388)", async () => {
    const env = EnvironmentId.make("shared-upload-regression");
    const uploadId = "pending-00000000-0000-4000-8000-000000000001-pdf";
    const file = {
      id: "local",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
      uploadedAttachmentId: uploadId,
      uploadEnvironmentId: env,
    };
    harness.environments = [environment(env)];
    harness.items = [];
    harness.key.mockReturnValueOnce("first").mockReturnValueOnce("second");
    let exists = true;
    const cleanup = Promise.withResolvers<void>();
    harness.release.mockImplementation(async () => {
      if (!fileOwnership.isComposerAttachmentUploadRetained(env, uploadId)) exists = false;
      cleanup.resolve();
    });
    harness.verify.mockImplementation(async () => ({ status: exists ? "verified" : "missing" }));
    harness.upload
      .mockReset()
      .mockResolvedValue({ status: "uploaded", attachmentId: "replacement" });
    const received: Array<{ idempotencyKey: string; attachments: unknown }> = [];
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if (!("input" in args) || !("idempotencyKey" in args.input))
        return { _tag: "Success", value: bot(env) };
      received.push(args.input);
      [first, second, retried][received.length - 1]?.resolve();
      return received.length < 3
        ? { _tag: "Failure", cause: "lost receipt" }
        : { _tag: "Success", value: { inputId: "accepted", state: "accepted" } };
    });
    await render();
    await act(async () => {
      session.onSend("first", [file]);
      await first.promise;
    });
    await act(async () => {
      session.onSend("second", [file]);
      await second.promise;
    });
    await act(async () => {
      session.onDiscardInput("first");
      await cleanup.promise;
    });
    expect(exists).toBe(true);
    await act(async () => {
      session.onRetryInput("second");
      await retried.promise;
    });
    expect(received[2]).toMatchObject({
      idempotencyKey: "second",
      attachments: [{ id: uploadId }],
    });
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it("keeps failed uploads on disconnect and releases them when the environment is removed (#2388)", async () => {
    const env = EnvironmentId.make("removed-upload-regression");
    const file = {
      id: "local",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/removed.pdf",
      uploadedAttachmentId: "pending-removed",
      uploadEnvironmentId: env,
    };
    harness.environments = [environment(env)];
    harness.items = [];
    harness.verify.mockReset().mockResolvedValue({ status: "verified" });
    const sent = Promise.withResolvers<void>();
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if (!("input" in args) || !("idempotencyKey" in args.input))
        return { _tag: "Success", value: bot(env) };
      sent.resolve();
      return { _tag: "Failure", cause: "lost receipt" };
    });
    await render();
    await act(async () => {
      session.onSend("hello", [file]);
      await sent.promise;
    });
    harness.environments = [environment(env, false)];
    await render();
    expect(harness.release).not.toHaveBeenCalled();
    await act(async () => {
      await botSessions.disposeMobileGoatBotEnvironment(env);
    });
    expect(harness.release).toHaveBeenCalledWith([file]);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(false);
  });
  it("retries an ambiguous send with the same uploaded references and client key (#2388)", async () => {
    const env = EnvironmentId.make("retry-attachments");
    const uploadedId = "pending-00000000-0000-4000-8000-000000000001-pdf";
    const file = {
      id: "local",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
    };
    harness.environments = [environment(env)];
    harness.items = [];
    harness.upload.mockReset().mockResolvedValue({ status: "uploaded", attachmentId: uploadedId });
    harness.verify.mockReset().mockResolvedValue({ status: "verified" });
    const ingests: Array<{ idempotencyKey: string; attachments: unknown }> = [];
    const firstAttempt = Promise.withResolvers<void>();
    const secondAttempt = Promise.withResolvers<void>();
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if (!("input" in args) || !("idempotencyKey" in args.input))
        return { _tag: "Success", value: bot(env) };
      ingests.push(args.input);
      if (ingests.length === 1) firstAttempt.resolve();
      else secondAttempt.resolve();
      return ingests.length === 1
        ? { _tag: "Failure", cause: "lost receipt" }
        : { _tag: "Success", value: { inputId: "accepted", state: "accepted" } };
    });
    await render();
    await act(async () => {
      expect(session.onSend("hello", [file])).toBe(true);
      await firstAttempt.promise;
    });
    expect(session.rows.some((row) => row.kind === "user" && row.delivery.state === "failed")).toBe(
      true,
    );
    await act(async () => {
      session.onRetryInput("request");
      await secondAttempt.promise;
    });
    expect(ingests).toHaveLength(2);
    expect(
      ingests.map(({ idempotencyKey, attachments }) => ({ idempotencyKey, attachments })),
    ).toEqual([
      {
        idempotencyKey: "request",
        attachments: [
          {
            type: "file",
            id: uploadedId,
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
          },
        ],
      },
      {
        idempotencyKey: "request",
        attachments: [
          {
            type: "file",
            id: uploadedId,
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
          },
        ],
      },
    ]);
    expect(harness.upload).toHaveBeenCalledTimes(1);
  });
  it("keeps a missing legacy stored bot offline without ensuring on another server", async () => {
    harness.botRef = bot(EnvironmentId.make("missing-A"));
    harness.environments = [environment("missing-B")];
    await render();
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(session.availability).toBe("offline");
    // Links in the history still shown resolve where that history lives.
    expect(session.historyEnvironmentId).toBe(EnvironmentId.make("missing-A"));
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
// A session run waiting on approval while its tool call runs; only the approval may show.
const detail = (requestStatus: "pending" | "resolved") => ({
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
    setup({ environmentId: "env", threadId: "worker-1", runId: "run-1" });
    registry.set(detailAtom, detail("pending"));
    const unmountOtherScreen = registry.mount(detailAtom);
    try {
      await render();
      expect(session.activity?.text).toBe("Waiting for your approval");
      await act(async () => registry.set(detailAtom, detail("resolved")));
      expect(session.activity?.text).toBe("Copying files");
    } finally {
      unmountOtherScreen();
    }
  });

  it("never reads a remote worker through a local thread with the same id", async () => {
    setup({ environmentId: "env", threadId: "worker-1", host: "mac-studio" });
    registry.set(detailAtom, detail("pending"));
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
