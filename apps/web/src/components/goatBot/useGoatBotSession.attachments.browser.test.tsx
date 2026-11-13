import {
  ChannelBindingId,
  ChannelConversationId,
  ChannelInputId,
  ChannelTaskId,
  type ChatAttachment,
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ProjectId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import { useLayoutEffect, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  goatBotAttachments: true,
  uploads: [] as Array<ReadonlyArray<{ readonly name: string }>>,
  released: [] as Array<ReadonlyArray<string>>,
  connected: true,
  staged: null as import("./goatBotAttachments").GoatBotDraftAttachment | null,
  stageGate: null as Promise<void> | null,
  stageStarted: () => {},
  stageFinished: () => {},
  uploadGate: null as Promise<void> | null,
  uploadStarted: () => {},
  uploadFinished: () => {},
  session: null as ReturnType<typeof import("./useGoatBotSession").useGoatBotSession> | null,
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/channels", async (original) => ({
  ...(await original<typeof import("~/state/channels")>()),
  channelEnvironment: { updateTaskView: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({ rows: [], refresh: () => {} }),
  useBotThreads: () => ({
    rows: [],
    supported: true,
    loaded: true,
    failed: false,
    turnsWaiting: [],
    refresh: () => {},
  }),
}));
vi.mock("./GoatBotWorkDetails", () => ({ GoatBotWorkDetails: () => null }));
vi.mock("~/hooks/useResizableWidth", () => ({
  RESIZABLE_WIDTH_PROPERTY: "--resizable-width",
  useResizableWidth: () => ({ width: 480, handlers: {} }),
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./useGoatBotHome", () => ({
  useGoatBotHome: () => undefined,
  useGoatBotHomeSettings: () => ({ moveTarget: null, busy: false, error: null }),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./goatBotHooks", () => ({
  useGoatBotEnvironments: () => [
    {
      environmentId: "bot-home",
      connected: mocks.connected,
      supportsChannelLedger: true,
      primary: true,
    },
  ],
  useLegacyGlobalAgentRoute: () => null,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useEnvironmentShellsBootstrapped: () => true,
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
  useTimelineVisibleTurnItems: () => [],
  useThreadShell: () => null,
  useServerConfigs: () =>
    new Map([
      [
        "bot-home",
        {
          environment: {
            capabilities: {
              attachmentUploads: true,
              goatBotAttachments: mocks.goatBotAttachments,
              fileAttachments: { maxUploadBytes: 1024 * 1024 },
            },
          },
        },
      ],
    ]),
}));
// Uploading is an HTTP transfer to the server; ingest must name what it returned.
vi.mock("./goatBotAttachments", async (importOriginal) => {
  const original = await importOriginal<typeof import("./goatBotAttachments")>();
  return {
    ...original,
    stageGoatBotFiles: async (...args: Parameters<typeof original.stageGoatBotFiles>) => {
      mocks.stageStarted();
      if (mocks.stageGate) await mocks.stageGate;
      mocks.stageFinished();
      return mocks.staged === null
        ? original.stageGoatBotFiles(...args)
        : { staged: [mocks.staged], error: null };
    },
    releaseGoatBotAttachments: (
      attachments: Parameters<typeof original.releaseGoatBotAttachments>[0],
    ) => {
      mocks.released.push(attachments.map((attachment) => attachment.name));
      original.releaseGoatBotAttachments(attachments);
    },
    uploadGoatBotAttachments: async (
      _environmentId: string,
      attachments: ReadonlyArray<{ readonly name: string; readonly mimeType: string }>,
    ): Promise<ReadonlyArray<ChatAttachment>> => {
      mocks.uploads.push(attachments);
      mocks.uploadStarted();
      if (mocks.uploadGate) await mocks.uploadGate;
      mocks.uploadFinished();
      return attachments.map((attachment, index) => ({
        type: "file",
        id: `uploaded-${index}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: 5,
      }));
    },
  };
});

import { useGlobalAgentStore } from "~/globalAgentStore";
import { readAttachmentUpload, useAttachmentUploadStore } from "~/lib/attachmentUploadQueue";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotTaskPane } from "./GoatBotTaskPane";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import * as attachments from "./goatBotAttachments";
import { disposeGoatBotEnvironment } from "./goatBotEnvironmentLifecycle";
import { useGoatBotSession } from "./useGoatBotSession";

const environmentId = EnvironmentId.make("bot-home");
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

function setup(goatBotAttachments: boolean) {
  mocks.goatBotAttachments = goatBotAttachments;
  mocks.connected = true;
  mocks.staged = null;
  mocks.stageGate = null;
  mocks.stageStarted = () => {};
  mocks.stageFinished = () => {};
  mocks.uploadGate = null;
  mocks.uploadStarted = () => {};
  mocks.uploadFinished = () => {};
  mocks.session = null;
  mocks.uploads.length = 0;
  mocks.released.length = 0;
  useGlobalAgentStore.setState({ ref: null, botRef: null, mode: "bot" });
  const port: GoatBotChannelPort = {
    ensureBot: vi.fn(async () => ({
      environmentId,
      threadId: ThreadId.make("bot"),
      projectId: ProjectId.make("project"),
    })),
    ingest: vi.fn(async (_environment, input) => ({
      inputId: ChannelInputId.make(input.idempotencyKey),
      conversationId: ChannelConversationId.make("conversation"),
      bindingId: ChannelBindingId.make("binding"),
      duplicate: false,
      state: "accepted" as const,
      acceptedAt: "2026-11-03T12:00:00.000Z",
      taskIds: [],
    })),
    getBotStatus: vi.fn(async () => ({ bot: null, waitingCount: 0 })),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    useCanSend: () => true,
  };
  return port;
}

function Session({ items }: { readonly items?: ReadonlyArray<OrchestrationV2ProjectedTurnItem> }) {
  const session = useGoatBotSession(items);
  useLayoutEffect(() => {
    mocks.session = session;
  }, [session]);
  return <GoatBotChatView {...session} environmentId={environmentId} legacyAgentRoute={null} />;
}

it("sends a picked file with the GOAT Bot message when the server takes files", async () => {
  const port = setup(true);
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
    { router: false }, // The bot screen here has no links to follow.
  );
  await expect.element(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("expected the file picker");
  await userEvent.upload(input, new File(["notes"], "notes.txt", { type: "text/plain" }));
  await expect
    .element(screen.getByRole("list", { name: "Attachments" }))
    .toHaveTextContent("notes.txt");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  expect(mocks.uploads.map((files) => files.map((file) => file.name))).toEqual([["notes.txt"]]);
  expect(vi.mocked(port.ingest).mock.calls[0]![1]).toMatchObject({
    text: "",
    attachments: [{ id: "uploaded-0", name: "notes.txt", type: "file" }],
  });
  await expect.element(screen.getByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  // The sent bubble names its file even without text.
  await expect.element(screen.getByText("notes.txt")).toBeVisible();
});

it("discarding a failed message releases its uploaded files", async () => {
  const port = setup(true);
  vi.mocked(port.ingest).mockRejectedValueOnce(new Error("connection lost"));
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("expected the file picker");
  await userEvent.upload(input, new File(["notes"], "discard.txt", { type: "text/plain" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByText("Not Delivered")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  await expect.element(screen.getByText("Not Delivered")).not.toBeInTheDocument();
  expect(mocks.released).toContainEqual(["discard.txt"]);
});

function fileDrag(type: "dragenter" | "dragover" | "drop", file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
}

it("attaches a file dropped on the GOAT Bot chat and sends it with the message", async () => {
  const port = setup(true);
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
    { router: false }, // The bot screen here has no links to follow.
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = new File(["notes"], "dropped.txt", { type: "text/plain" });
  const conversation = screen.getByRole("textbox", { name: "Message GOAT Bot" }).element();
  await act(() => conversation.dispatchEvent(fileDrag("dragenter", file)));
  await expect.element(screen.getByText("Drop files to attach")).toBeVisible();
  const drop = fileDrag("drop", file);
  await act(() => conversation.dispatchEvent(drop));
  expect(drop.defaultPrevented).toBe(true);
  await expect.element(screen.getByText("Drop files to attach")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("list", { name: "Attachments" }))
    .toHaveTextContent("dropped.txt");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  expect(mocks.uploads.map((files) => files.map((upload) => upload.name))).toEqual([
    ["dropped.txt"],
  ]);
  expect(vi.mocked(port.ingest).mock.calls[0]![1]).toMatchObject({
    attachments: [{ id: "uploaded-0", name: "dropped.txt", type: "file" }],
  });
});

it("releases staged files when preparation finishes after the composer unmounts", async () => {
  const port = setup(true);
  const file = image("late-preparation");
  let start!: () => void;
  let finish!: () => void;
  let complete!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.stageGate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  mocks.stageStarted = start;
  mocks.stageFinished = finish;
  mocks.staged = file;
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("expected the file picker");
  await userEvent.upload(input, file.file);
  await started;
  await screen.unmount();
  await act(async () => {
    complete();
    await finished;
  });
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
  attachments.retainGoatBotAttachments([file]);
  attachments.releaseGoatBotAttachments([file]);
  expect(revoked).toHaveBeenCalledTimes(2);
});

it("keeps a staged preview shared with another owner after the composer unmounts", async () => {
  const port = setup(true);
  const owner = image("live-preview-owner");
  const staged = { ...image("late-preview-alias"), previewUrl: owner.previewUrl };
  let start!: () => void;
  let finish!: () => void;
  let complete!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.stageGate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  mocks.stageStarted = start;
  mocks.stageFinished = finish;
  mocks.staged = staged;
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  attachments.retainGoatBotAttachments([owner]);
  try {
    await using screen = await render(
      <GoatBotChannelContext value={port}>
        <Session />
      </GoatBotChannelContext>,
    );
    await expect.element(screen.getByRole("button", { name: "Attach files" })).toBeVisible();
    const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("expected the file picker");
    await userEvent.upload(input, staged.file);
    await started;
    await screen.unmount();
    await act(async () => {
      complete();
      await finished;
    });
    expect(revoked).not.toHaveBeenCalledWith(owner.previewUrl);
  } finally {
    attachments.releaseGoatBotAttachments([owner]);
  }
  expect(revoked).toHaveBeenCalledExactlyOnceWith(owner.previewUrl);
});

function image(id: string) {
  return {
    id,
    type: "image" as const,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 5,
    previewUrl: `blob:${id}`,
    file: new File(["image"], `${id}.png`, { type: "image/png" }),
  };
}

it("keeps a shared attachment until both failed messages are discarded", async () => {
  const port = setup(true);
  vi.mocked(port.ingest).mockRejectedValue(new Error("connection lost"));
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = image("shared-messages");
  await act(() => {
    mocks.session?.onSend("one", [file]);
    mocks.session?.onSend("two", [file]);
  });
  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(2));
  const keys = vi.mocked(port.ingest).mock.calls.map((call) => call[1].idempotencyKey);
  await act(() => mocks.session?.onDiscardInput(keys[0]!));
  expect(revoked).not.toHaveBeenCalledWith(file.previewUrl);
  await act(() => mocks.session?.onDiscardInput(keys[1]!));
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
});

it.each(["discarded", "sent"] as const)(
  "keeps a draft's shared attachment when a message is %s",
  async (outcome) => {
    const port = setup(true);
    if (outcome === "discarded")
      vi.mocked(port.ingest).mockRejectedValue(new Error("connection lost"));
    using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await using screen = await render(
      <GoatBotChannelContext value={port}>
        <Session />
      </GoatBotChannelContext>,
    );
    await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
    const file = image("shared-draft");
    mocks.staged = file;
    const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("expected the file picker");
    await userEvent.upload(input, file.file);
    await expect
      .element(screen.getByRole("list", { name: "Attachments" }))
      .toHaveTextContent(file.name);
    await act(() => {
      mocks.session?.onSend("one", [file]);
    });
    await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
    const key = vi.mocked(port.ingest).mock.calls[0]![1].idempotencyKey;
    if (outcome === "discarded") await act(() => mocks.session?.onDiscardInput(key));
    else await vi.waitFor(() => expect(mocks.released).toContainEqual([file.name]));
    expect(revoked).not.toHaveBeenCalledWith(file.previewUrl);
    await userEvent.click(screen.getByRole("button", { name: `Remove ${file.name}` }));
    expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
  },
);

it("keeps a preview shared by distinct attachment IDs until the last owner releases it", () => {
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const first = image("preview-first");
  const second = { ...image("preview-second"), previewUrl: first.previewUrl };
  attachments.retainGoatBotAttachments([first, second]);
  attachments.releaseGoatBotAttachments([first]);
  expect(revoked).not.toHaveBeenCalledWith(first.previewUrl);
  attachments.releaseGoatBotAttachments([second]);
  expect(revoked).toHaveBeenCalledExactlyOnceWith(first.previewUrl);
});

it("keeps a pending upload shared by different attachment IDs until the last owner releases it", () => {
  const first = {
    id: "upload-alias-a",
    type: "file" as const,
    name: "shared.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    file: new File(["notes"], "shared.txt"),
    uploadedAttachmentId: "pending-shared",
    uploadEnvironmentId: environmentId,
  };
  const second = { ...first, id: "upload-alias-b" };
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [first.id]: { status: "ready", environmentId, attachmentId: "pending-shared" },
      [second.id]: { status: "ready", environmentId, attachmentId: "pending-shared" },
    },
  });
  attachments.retainGoatBotAttachments([first, second]);
  attachments.releaseGoatBotAttachments([first]);
  expect(readAttachmentUpload(first.id)?.status).toBe("ready");
  attachments.releaseGoatBotAttachments([second]);
  expect(readAttachmentUpload(first.id)).toBeUndefined();
  expect(readAttachmentUpload(second.id)).toBeUndefined();
});

it("keeps failed attachments on disconnect and releases them on environment removal", async () => {
  const port = setup(true);
  vi.mocked(port.ingest).mockRejectedValue(new Error("connection lost"));
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = image("removed-environment");
  await act(() => {
    mocks.session?.onSend("one", [file]);
  });
  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  mocks.connected = false;
  await screen.rerender(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  expect(revoked).not.toHaveBeenCalledWith(file.previewUrl);
  await expect.element(screen.getByText("Not Delivered")).toBeVisible();
  await screen.unmount();
  await act(() => disposeGoatBotEnvironment(environmentId));
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
});

it("removes an environment without waiting for an upload or sending after it finishes", async () => {
  const port = setup(true);
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let start!: () => void;
  let finish!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.uploadGate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  mocks.uploadStarted = start;
  mocks.uploadFinished = finish;
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = image("in-flight-removal");
  await act(async () => {
    mocks.session?.onSend("one", [file]);
    await started;
  });
  await screen.unmount();
  try {
    await act(() => disposeGoatBotEnvironment(environmentId));
    expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
    expect(port.ingest).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      unblock();
      await finished;
    });
  }
  expect(port.ingest).not.toHaveBeenCalled();
});

it("releases a failed message's attachments when its committed projection arrives", async () => {
  const port = setup(true);
  vi.mocked(port.ingest).mockRejectedValue(new Error("lost receipt"));
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session items={[]} />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = image("projected");
  await act(() => {
    mocks.session?.onSend("one", [file]);
  });
  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  const key = vi.mocked(port.ingest).mock.calls[0]![1].idempotencyKey;
  const item = decodeItem({
    id: key,
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: "2026-10-12T12:00:00.000Z",
    completedAt: "2026-10-12T12:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    type: "user_message",
    messageId: key,
    inputIntent: "turn_start",
    text: "one",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel: { conversationId: "conversation", originKind: "goat", kind: "inbound", inputId: key },
  });
  const items: OrchestrationV2ProjectedTurnItem[] = [
    {
      item,
      position: 0,
      visibility: "local",
      sourceThreadId: ThreadId.make("bot"),
      sourceItemId: item.id,
    },
  ];
  await screen.rerender(
    <GoatBotChannelContext value={port}>
      <Session items={items} />
    </GoatBotChannelContext>,
  );
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
});

it("offers no attach button or drop target when GOAT Bot's server cannot take files", async () => {
  const port = setup(false);
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
    { router: false }, // The bot screen here has no links to follow.
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  expect(screen.container.querySelector('button[aria-label="Attach files"]')).toBeNull();
  const file = new File(["notes"], "refused.txt", { type: "text/plain" });
  const conversation = screen.getByRole("textbox", { name: "Message GOAT Bot" }).element();
  const over = fileDrag("dragover", file);
  await act(() => conversation.dispatchEvent(fileDrag("dragenter", file)));
  await act(() => conversation.dispatchEvent(over));
  expect(over.defaultPrevented).toBe(false);
  expect(screen.container.querySelector("[data-chat-workspace-drop-overlay]")).toBeNull();
});

function TaskPaneWithSession() {
  const session = useGoatBotSession(undefined, null);
  return (
    <GoatBotTaskPane
      environmentId={environmentId}
      session={session}
      taskId={ChannelTaskId.make("task-1")}
      narrow
      onClose={() => {}}
    />
  );
}

it("sends task composer messages through the session queue with the task id", async () => {
  const port = setup(true);
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <TaskPaneWithSession />
    </GoatBotChannelContext>,
    { router: false }, // The composer has no links.
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  await userEvent.type(screen.getByRole("textbox", { name: "Message GOAT Bot" }), "hello{Enter}");
  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  expect(vi.mocked(port.ingest).mock.calls[0]?.[1]).toMatchObject({
    text: "hello",
    intent: "message",
    taskId: "task-1",
  });
});
