import {
  ChannelBindingId,
  ChannelConversationId,
  ChannelInputId,
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
  session: null as ReturnType<typeof import("./useGoatBotSession").useGoatBotSession> | null,
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
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import * as sessions from "./useGoatBotSession";
import * as attachments from "./goatBotAttachments";
import { useGoatBotSession } from "./useGoatBotSession";

const environmentId = EnvironmentId.make("bot-home");
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

function setup(goatBotAttachments: boolean) {
  mocks.goatBotAttachments = goatBotAttachments;
  mocks.connected = true;
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

it("keeps a draft's shared attachment when a failed message is discarded", async () => {
  const port = setup(true);
  vi.mocked(port.ingest).mockRejectedValue(new Error("connection lost"));
  using revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  const file = image("shared-draft");
  const retain = Reflect.get(attachments, "retainGoatBotAttachments");
  expect(retain).toBeTypeOf("function");
  retain([file]);
  await act(() => {
    mocks.session?.onSend("one", [file]);
  });
  await vi.waitFor(() => expect(port.ingest).toHaveBeenCalledTimes(1));
  const key = vi.mocked(port.ingest).mock.calls[0]![1].idempotencyKey;
  await act(() => mocks.session?.onDiscardInput(key));
  expect(revoked).not.toHaveBeenCalledWith(file.previewUrl);
  attachments.releaseGoatBotAttachments([file]);
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
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
  const dispose = Reflect.get(sessions, "disposeWebGoatBotEnvironment");
  expect(dispose).toBeTypeOf("function");
  await act(() => dispose(environmentId));
  expect(revoked).toHaveBeenCalledExactlyOnceWith(file.previewUrl);
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

it("offers no attach button when GOAT Bot's server cannot take files", async () => {
  const port = setup(false);
  await using screen = await render(
    <GoatBotChannelContext value={port}>
      <Session />
    </GoatBotChannelContext>,
    { router: false }, // The bot screen here has no links to follow.
  );
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toBeEnabled();
  expect(screen.container.querySelector('button[aria-label="Attach files"]')).toBeNull();
});
