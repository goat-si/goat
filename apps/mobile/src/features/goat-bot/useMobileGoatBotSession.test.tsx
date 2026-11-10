import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  resolveGoatBotHomeSelection,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import {
  BotProfile,
  EnvironmentId,
  ChannelTaskId,
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
  supportsTaskThreads: false,
  run: vi.fn(),
  save: vi.fn(),
  items: [] as ReadonlyArray<unknown>,
  workerShell: null as object | null,
  shellReads: [] as Array<string | null>,
  upload: vi.fn(),
  transfer: vi.fn(),
  verify: vi.fn(),
  release: vi.fn(async (_attachments: ReadonlyArray<unknown>) => {}),
  key: vi.fn(() => "request"),
  refresh: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    upload(url: string, options: unknown) {
      return harness.transfer(this.uri, url, options);
    }
  },
  Paths: { document: { uri: "file:///documents" } },
  UploadType: { BINARY_CONTENT: 0 },
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
    atom === permissionAtom ? true : atom === connectionAtom ? connection : AsyncResult.initial(),
  useAtomSet: () => harness.save,
  useAtomRefresh: () => harness.refresh,
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
    listBotThreads: () => threadsAtom,
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
  useServerConfigs: () =>
    new Map(
      harness.environments.map(({ environmentId }) => [
        environmentId,
        { environment: { capabilities: { goatBotTaskThreads: harness.supportsTaskThreads } } },
      ]),
    ),
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
import { syncMobileGoatBotMembers } from "./mobileGoatBotMembers";
import * as fileOwnership from "../../lib/composerAttachmentFiles";

const permissionAtom = Atom.make(true);
const connectionAtom = Atom.make(connection);
const detailAtom = Atom.make<unknown>(null);
const threadsAtom = Atom.make(AsyncResult.initial());
const registry = Object.assign(AtomRegistry.make(), {
  get: (atom: unknown) =>
    atom === preparedConnection ? Option.some({ httpBaseUrl: "https://example.test" }) : connection,
});
let root: Root | null = null;
let session: ReturnType<typeof useMobileGoatBotSession>;
let taskId: ChannelTaskId | undefined;
let member: BotProfile | null = null;
function Consumer() {
  const value = useMobileGoatBotSession(true, taskId, member);
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
  taskId = undefined;
  member = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [];
  harness.botRef = null;
  harness.loaded = true;
  harness.supportsTaskThreads = false;
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
  it("does not wait for a late upload mint or delete it after environment removal", async () => {
    const env = EnvironmentId.make("removed-during-mint");
    const file = {
      id: "minting",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/minting.pdf",
    };
    const started = Promise.withResolvers<void>();
    const mint = Promise.withResolvers<void>();
    const minted = Promise.withResolvers<void>();
    const deletes: unknown[] = [];
    harness.environments = [environment(env)];
    harness.items = [];
    harness.upload.mockReset().mockImplementation(async (input) => {
      started.resolve();
      await mint.promise;
      expect(input.onMinted("pending-late")).toBe("abandon");
      minted.resolve();
      return { status: "cancelled", attachmentId: "pending-late" };
    });
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if ("input" in args && "attachmentId" in args.input) deletes.push(args.input.attachmentId);
      return { _tag: "Success", value: bot(env) };
    });
    await render();
    await act(async () => {
      session.onSend("hello", [file]);
      await started.promise;
    });
    await act(async () => {
      await botSessions.disposeMobileGoatBotEnvironment(env);
    });
    expect(harness.release).toHaveBeenCalledWith([file]);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(false);
    await act(async () => {
      mint.resolve();
      await minted.promise;
    });
    expect(deletes).toEqual([]);
  });
  it("returns from removal immediately and releases the file after the aborted transfer settles", async () => {
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
    const released = Promise.withResolvers<void>();
    harness.release.mockImplementation(async () => {
      released.resolve();
    });
    let signal: AbortSignal | undefined;
    harness.transfer.mockReset().mockImplementation(async (_uri, _url, options) => {
      signal = options.signal;
      started.resolve();
      await transfer.promise;
      throw new Error("transfer aborted");
    });
    harness.upload.mockReset().mockImplementation(async (input) => {
      expect(input.onMinted(uploadId)).toBe("continue");
      try {
        await input.transport("https://example.test/upload").done;
        return { status: "uploaded", attachmentId: uploadId };
      } catch (error) {
        return { status: "failed", step: "transfer", attachmentId: uploadId, error };
      }
    });
    const ingests: unknown[] = [];
    const deletes: unknown[] = [];
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if ("input" in args && "attachmentId" in args.input) {
        deletes.push(args.input.attachmentId);
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
    await act(async () => {
      void botSessions.disposeMobileGoatBotEnvironment(env).then(() => {
        settled = true;
      });
      await Promise.resolve();
    });
    try {
      expect(settled).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(true);
      expect(harness.release).not.toHaveBeenCalled();
    } finally {
      transfer.resolve();
    }
    await act(async () => {
      await released.promise;
    });
    expect(ingests).toEqual([]);
    expect(deletes).toEqual([]);
    expect(harness.release).toHaveBeenCalledWith([file]);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(false);
  });
  it("returns from removal while a transfer and an earlier cleanup remain stalled", async () => {
    const env = EnvironmentId.make("stalled-removal");
    const file = {
      id: "held",
      type: "file" as const,
      name: "held.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/stalled.pdf",
    };
    const extra = {
      ...file,
      id: "extra",
      fileUri: "file:///documents/stalled-extra.pdf",
      uploadedAttachmentId: "pending-extra",
      uploadEnvironmentId: env,
    };
    const queued = {
      ...file,
      id: "queued",
      fileUri: "file:///documents/stalled-queued.pdf",
      uploadedAttachmentId: "pending-queued",
      uploadEnvironmentId: env,
    };
    const cleanupStarted = Promise.withResolvers<void>();
    const queuedCleanup = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const transfer = Promise.withResolvers<never>();
    const failed = Promise.withResolvers<void>();
    const deletes: unknown[] = [];
    let signal: AbortSignal | undefined;
    harness.environments = [environment(env)];
    harness.items = [];
    harness.key
      .mockReturnValueOnce("old")
      .mockReturnValueOnce("held")
      .mockReturnValueOnce("queued");
    harness.release.mockImplementation(async (files) => {
      if (
        files.some(
          (file) =>
            typeof file === "object" && file !== null && "id" in file && file.id === "queued",
        )
      )
        queuedCleanup.resolve();
      cleanupStarted.resolve();
      await cleanup.promise;
    });
    harness.transfer.mockImplementation((_uri, _url, options) => {
      signal = options.signal;
      started.resolve();
      return transfer.promise;
    });
    harness.upload.mockImplementation(async (input) => {
      input.onMinted("pending-held");
      await input.transport("https://example.test/upload").done;
      return { status: "uploaded", attachmentId: "pending-held" };
    });
    harness.run.mockImplementation(async (_registry, _command, args) => {
      if ("input" in args && "attachmentId" in args.input) deletes.push(args.input.attachmentId);
      if ("input" in args && "idempotencyKey" in args.input) {
        failed.resolve();
        return { _tag: "Failure", cause: "offline" };
      }
      return { _tag: "Success", value: bot(env) };
    });
    await render();
    await act(async () => {
      session.onSend("first");
      await failed.promise;
    });
    await act(async () => {
      session.onDiscardInput("old");
      await cleanupStarted.promise;
    });
    await act(async () => {
      session.onSend("second", [file, extra]);
      await started.promise;
    });
    await act(async () => {
      expect(session.onSend("queued", [queued])).toBe(true);
    });
    expect(session.rows.some((row) => row.kind === "user" && row.text === "queued")).toBe(true);
    let settled = false;
    await act(async () => {
      void botSessions.disposeMobileGoatBotEnvironment(env).then(() => {
        settled = true;
      });
      await queuedCleanup.promise;
    });
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(fileOwnership.isComposerAttachmentFileRetained(file.fileUri)).toBe(true);
    expect(fileOwnership.isComposerAttachmentFileRetained(extra.fileUri)).toBe(false);
    expect(fileOwnership.isComposerAttachmentFileRetained(queued.fileUri)).toBe(false);
    expect(fileOwnership.isComposerAttachmentUploadRetained(env, "pending-extra")).toBe(false);
    expect(fileOwnership.isComposerAttachmentUploadRetained(env, "pending-queued")).toBe(false);
    expect(harness.release).toHaveBeenCalledWith([expect.objectContaining({ id: "extra" })]);
    expect(harness.release).toHaveBeenCalledWith([expect.objectContaining({ id: "queued" })]);
    expect(harness.release).not.toHaveBeenCalledWith([expect.objectContaining({ id: "held" })]);
    expect(deletes).toEqual([]);
  });
  it("repeated removals retain only the files still used by stalled transfers", async () => {
    const activeUris: string[] = [];
    const otherUris: string[] = [];
    for (const index of [1, 2]) {
      const env = EnvironmentId.make(`removed-repeated-${index}`);
      const file = {
        id: `active-${index}`,
        type: "file" as const,
        name: "held.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: `file:///documents/repeated-active-${index}.pdf`,
      };
      const other = {
        ...file,
        id: `queued-${index}`,
        fileUri: `file:///documents/repeated-queued-${index}.pdf`,
      };
      const started = Promise.withResolvers<void>();
      const transfer = Promise.withResolvers<never>();
      harness.environments = [environment(env)];
      harness.items = [];
      harness.key.mockReturnValueOnce(`active-${index}`).mockReturnValueOnce(`queued-${index}`);
      harness.transfer.mockImplementation(() => {
        started.resolve();
        return transfer.promise;
      });
      harness.upload.mockImplementation(async (input) => {
        input.onMinted(`pending-${index}`);
        await input.transport("https://example.test/upload").done;
        return { status: "uploaded", attachmentId: `pending-${index}` };
      });
      await render();
      await act(async () => {
        session.onSend("active", [file]);
        await started.promise;
      });
      await act(async () => {
        session.onSend("queued", [other]);
      });
      await act(async () => {
        await botSessions.disposeMobileGoatBotEnvironment(env);
      });
      activeUris.push(file.fileUri);
      otherUris.push(other.fileUri);
      expect(activeUris.map(fileOwnership.isComposerAttachmentFileRetained)).toEqual(
        activeUris.map(() => true),
      );
      expect(otherUris.map(fileOwnership.isComposerAttachmentFileRetained)).toEqual(
        otherUris.map(() => false),
      );
    }
  });
  it("releases an earlier attachment while a later attachment is transferring", async () => {
    const env = EnvironmentId.make("later-transfer-removal");
    const first = {
      id: "first",
      type: "file" as const,
      name: "first.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/earlier.pdf",
    };
    const second = { ...first, id: "second", fileUri: "file:///documents/later.pdf" };
    const started = Promise.withResolvers<void>();
    const transfer = Promise.withResolvers<never>();
    const released = Promise.withResolvers<void>();
    let count = 0;
    harness.environments = [environment(env)];
    harness.items = [];
    harness.release.mockImplementation(async () => {
      released.resolve();
    });
    harness.transfer.mockImplementation(() =>
      ++count === 1 ? Promise.resolve({ status: 204 }) : (started.resolve(), transfer.promise),
    );
    harness.upload.mockImplementation(async (input) => {
      input.onMinted(`pending-${count}`);
      await input.transport("https://example.test/upload").done;
      return { status: "uploaded", attachmentId: `pending-${count}` };
    });
    await render();
    await act(async () => {
      session.onSend("two files", [first, second]);
      await started.promise;
    });
    await act(async () => {
      await botSessions.disposeMobileGoatBotEnvironment(env);
      await released.promise;
    });
    expect(fileOwnership.isComposerAttachmentFileRetained(first.fileUri)).toBe(false);
    expect(fileOwnership.isComposerAttachmentFileRetained(second.fileUri)).toBe(true);
    expect(harness.release).toHaveBeenCalledWith([first]);
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
    expect(harness.release).toHaveBeenCalledWith([
      {
        id: file.id,
        type: file.type,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        fileUri: file.fileUri,
      },
    ]);
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

  it("follows the acknowledged worker's shell, with when the work began and what it is", async () => {
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

it("filters the task conversation and sends messages with its task id", async () => {
  const env = EnvironmentId.make("task-conversation");
  harness.environments = [environment(env)];
  harness.botRef = bot(env);
  harness.items = conversation({ environmentId: "env", threadId: "worker-1" });
  harness.supportsTaskThreads = true;
  taskId = ChannelTaskId.make("task-1");
  const sent = Promise.withResolvers<unknown>();
  harness.run.mockImplementation(async (_registry, _command, args) => {
    if (args.input?.intent === "message") sent.resolve(args.input);
    return { _tag: "Success", value: bot(env) };
  });
  await render();
  expect(session.rows.some((row) => row.kind === "bot" && row.text === "Checking now.")).toBe(true);
  expect(session.rows.some((row) => row.kind === "user" && row.text === "Check the disks")).toBe(
    false,
  );
  await act(async () => {
    expect(session.onSend("Follow up")).toBe(true);
  });
  expect(await sent.promise).toMatchObject({
    intent: "message",
    taskId: "task-1",
    text: "Follow up",
  });
  await botSessions.disposeMobileGoatBotEnvironment(env);
});

const decodeProfile = Schema.decodeSync(BotProfile);
it("sends a member's message to the member's own conversation, and stops once it is deleted", async () => {
  const env = EnvironmentId.make("member-conversation");
  harness.environments = [environment(env)];
  harness.botRef = bot(env);
  harness.items = [];
  const profile = (state: "active" | "deleted") =>
    decodeProfile({
      botId: "research",
      role: "member",
      name: "Research",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
      defaultProjectId: null,
      environmentId: env,
      sessionThreadId: "thread-research",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      state,
    });
  member = profile("active");
  const sent = Promise.withResolvers<{ conversationKey: string; replyAddress: object }>();
  harness.run.mockImplementation(async (_registry, _command, args) => {
    if (args.input?.intent === "message") {
      sent.resolve(args.input);
      return { _tag: "Success", value: { inputId: "accepted", state: "accepted" } };
    }
    return { _tag: "Success", value: bot(env) };
  });
  await render();
  expect(session.threadId).toBe("thread-research");
  await act(async () => {
    expect(session.onSend("find sources")).toBe(true);
  });
  expect(await sent.promise).toMatchObject({
    conversationKey: "thread-research",
    replyAddress: { kind: "goat", environmentId: env, threadId: "thread-research" },
    text: "find sources",
  });
  // The roster no longer lists the member (deleted on another device): nothing more is sent,
  // even from a screen still holding the old profile.
  harness.run.mockClear();
  syncMobileGoatBotMembers(env, []);
  await act(async () => {
    session.onSend("after delete");
  });
  expect(harness.run.mock.calls.filter(([, , args]) => args.input?.intent === "message")).toEqual(
    [],
  );
  member = profile("deleted");
  await render();
  expect(session.canSend).toBe(false);
  expect(session.onSend("still there?")).toBe(false);
  await botSessions.disposeMobileGoatBotEnvironment(env);
});

it("refreshes the work list per finished record or chip move (card or not), not per streamed chunk", async () => {
  harness.environments = [environment("env")];
  harness.botRef = bot(EnvironmentId.make("env"));
  harness.supportsTaskThreads = true;
  const items = conversation({ environmentId: "env", threadId: "worker-1" });
  const [, ack, card] = items as OrchestrationV2ProjectedTurnItem[];
  const reply = (text: string, streaming: boolean) =>
    ({ ...ack, sourceItemId: "reply", item: { ...ack!.item, text, streaming } }) as typeof ack;
  const chip = card!.item as Extract<typeof card.item, { type: "notification" }>;
  const steps = [
    [...items, reply("Look", true)],
    [...items, reply("Looking at the disks", true)],
    [...items, reply("Looking at the disks.", false)],
    [
      items[0]!,
      ack!,
      { ...card!, item: { ...chip, ledgerTask: { ...chip.ledgerTask!, taskVersion: 2 } } },
      reply("Looking at the disks.", false),
    ],
  ];
  harness.items = items;
  await render();
  harness.refresh.mockClear();
  const counts: number[] = [];
  for (const step of steps) {
    harness.items = step;
    await render();
    counts.push(harness.refresh.mock.calls.length);
  }
  expect(counts).toEqual([0, 0, 1, 2]);
});
