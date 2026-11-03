import {
  ChannelBindingId,
  ChannelConversationId,
  ChannelInputId,
  type ChatAttachment,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import type { ReactNode } from "react";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  goatBotAttachments: true,
  uploads: [] as Array<ReadonlyArray<{ readonly name: string }>>,
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
    { environmentId: "bot-home", connected: true, supportsChannelLedger: true, primary: true },
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
vi.mock("./goatBotAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./goatBotAttachments")>()),
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
}));

import { useGlobalAgentStore } from "~/globalAgentStore";
import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { useGoatBotSession } from "./useGoatBotSession";

const environmentId = EnvironmentId.make("bot-home");

function setup(goatBotAttachments: boolean) {
  mocks.goatBotAttachments = goatBotAttachments;
  mocks.uploads.length = 0;
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

function Session() {
  const session = useGoatBotSession();
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
