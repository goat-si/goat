import {
  BotProfile,
  ChannelBindingId,
  ChannelConversationId,
  ChannelInputId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ChannelIngestInput,
  type ChannelIngestResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const environmentId = EnvironmentId.make("members-env");
vi.mock("./useGoatBotHome", () => ({
  useGoatBotHome: () => undefined,
  useGoatBotHomeSettings: () => ({ moveTarget: null, busy: false, error: null }),
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./goatBotHooks", () => ({
  useGoatBotEnvironments: () => [
    { environmentId: "members-env", connected: true, supportsChannelLedger: true, primary: true },
  ],
  useLegacyGlobalAgentRoute: () => null,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useThreadShell: () => ({ runtime: { activeRunId: null }, archivedAt: null, deletedAt: null }),
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: () => [],
  useEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { useGoatBotSession } from "./useGoatBotSession";

const decodeProfile = Schema.decodeSync(BotProfile);
const member = decodeProfile({
  botId: "research",
  role: "member",
  name: "Research",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId,
  sessionThreadId: "member-thread",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});

function Chat({ bot }: { bot: BotProfile | null }) {
  const session = useGoatBotSession(undefined, null, bot);
  return (
    <GoatBotMemberContext value={bot}>
      <section aria-label={bot === null ? "Main chat" : "Member chat"}>
        <GoatBotChatView {...session} legacyAgentRoute={null} />
      </section>
    </GoatBotMemberContext>
  );
}

it("sends a member's message to its own conversation and keeps its pending row out of the main chat", async () => {
  let release: (result: ChannelIngestResult) => void = () => {};
  const held = new Promise<ChannelIngestResult>((resolve) => {
    release = resolve;
  });
  const ingested: ChannelIngestInput[] = [];
  const port: GoatBotChannelPort = {
    ensureBot: vi.fn(async () => ({
      environmentId,
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("main-thread"),
    })),
    ingest: vi.fn(async (_environmentId, input) => {
      ingested.push(input);
      return held;
    }),
    getBotStatus: vi.fn(async () => ({ bot: null, waitingCount: 0 })),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    useCanSend: () => true,
  };
  await using _screen = await render(
    <GoatBotChannelContext.Provider value={port}>
      <Chat bot={member} />
      <Chat bot={null} />
    </GoatBotChannelContext.Provider>,
    { router: false }, // Only the chats render; no navigation happens.
  );
  const memberChat = page.getByRole("region", { name: "Member chat" });
  const box = memberChat.getByPlaceholder("Message Research");
  await expect.element(box).toBeEnabled();
  await userEvent.type(box, "find sources{Enter}");
  await vi.waitFor(() => expect(ingested).toHaveLength(1));
  expect(ingested[0]).toMatchObject({
    conversationKey: "member-thread",
    replyAddress: { kind: "goat", environmentId, threadId: "member-thread" },
    text: "find sources",
  });
  await expect.element(memberChat.getByText("find sources")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Main chat" }).getByText("find sources"))
    .not.toBeInTheDocument();
  release({
    inputId: ChannelInputId.make("member-input"),
    conversationId: ChannelConversationId.make("conversation"),
    bindingId: ChannelBindingId.make("binding"),
    duplicate: false,
    state: "accepted",
    acceptedAt: "2026-11-07T00:00:00.000Z",
    taskIds: [],
  });
});
