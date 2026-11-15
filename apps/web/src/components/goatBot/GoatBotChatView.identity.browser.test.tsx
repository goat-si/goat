import {
  EnvironmentId,
  ThreadId,
  type BotProfile,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "../../index.css";

const released = vi.hoisted(() => [] as Array<ReadonlyArray<string>>);
// Records which draft files the composer gives back.
vi.mock("./goatBotAttachments", async (original) => {
  const real = await original<typeof import("./goatBotAttachments")>();
  return {
    ...real,
    releaseGoatBotAttachments: (
      attachments: Parameters<typeof real.releaseGoatBotAttachments>[0],
    ) => {
      released.push(attachments.map((attachment) => attachment.name));
      real.releaseGoatBotAttachments(attachments);
    },
  };
});
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useThreadStatus: (ref: unknown) => (ref === null ? "empty" : "live"),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotMemberModelPicker", () => ({ GoatBotMemberModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { NavigationHoldsPaused } from "~/lib/navigationHolds";
import { GoatBotChatView } from "./GoatBotChatView";
import { useGoatBotHiddenChatNotice } from "./GoatBotHiddenChatNotice";
import { GoatBotChatHidden } from "./goatBotLayout";
import { GoatBotMemberContext } from "./goatBotMemberContext";

it("failing-first: a different bot with an unresolved projection does not inherit the old cue", async () => {
  const environmentId = EnvironmentId.make("env");
  const profile = (id: string) =>
    ({
      botId: id,
      role: "member",
      name: id,
      environmentId,
      sessionThreadId: ThreadId.make(id),
      state: "active",
    }) as BotProfile;
  const history: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-10-12T09:40:00Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const reply: GoatBotRow = {
    kind: "bot",
    id: "reply",
    text: "Reply",
    createdAt: "2026-10-12T09:41:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  };
  const view = (member: BotProfile, resolved: boolean, rows: ReadonlyArray<GoatBotRow>) => (
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <GoatBotMemberContext value={member}>
        <GoatBotChatView
          projectionRef={resolved ? { environmentId, threadId: member.sessionThreadId } : null}
          visibleTurnItems={rows.map(
            (row) =>
              ({
                item: { id: row.id, type: "assistant_message" },
              }) as unknown as OrchestrationV2ProjectedTurnItem,
          )}
          environmentId={environmentId}
          availability={{ kind: "ready", bot: { environmentId, threadId: member.sessionThreadId } }}
          canOperate
          rows={rows}
          onSend={() => true}
          onRetryInput={() => {}}
          legacyAgentRoute={null}
        />
      </GoatBotMemberContext>
    </div>
  );
  await using screen = await render(view(profile("first"), true, history));
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const shown = [...history, reply];
  await screen.rerender(view(profile("first"), true, shown));
  expect(screen.container.textContent).toContain("Jump to latest");
  await screen.rerender(view(profile("first"), false, shown));
  expect(screen.container.querySelector(".goat-timeline > div")).toBe(scroll);
  expect(screen.container.textContent).toContain("Jump to latest");
  await screen.rerender(view(profile("second"), false, shown));
  expect(screen.container.querySelector(".goat-timeline > div")).not.toBe(scroll);
  expect(screen.container.textContent).not.toContain("Jump to latest");
});

const env = EnvironmentId.make("env");
const research = {
  botId: "research",
  role: "member",
  name: "Research",
  environmentId: env,
  sessionThreadId: ThreadId.make("research-session"),
  state: "active",
} as BotProfile;
const UNSAVED_BEHIND =
  "The chat behind this task has open or unsaved work. Leaving this task closes it and discards unsaved changes.";

/** Resets the draft files a test's composer gave back. */
function setup() {
  released.length = 0;
}

/** The task pane's line about work in the chat behind it, read while the chat is hidden. */
function HiddenChatLine({ hidden }: { readonly hidden: boolean }) {
  return useGoatBotHiddenChatNotice(hidden).notice;
}

/** The chat beside a task as the task route renders it: one view whose bot follows the URL. */
function besideTask(options: {
  readonly member: BotProfile | null;
  readonly onSend: () => boolean;
  readonly hidden?: boolean;
  readonly connecting?: boolean;
  readonly rows?: ReadonlyArray<GoatBotRow>;
}) {
  const { member, onSend, hidden = false, connecting = false, rows = [] } = options;
  const threadId = member?.sessionThreadId ?? ThreadId.make("main-bot");
  return (
    <div style={{ display: "flex", height: 500, width: 480 }}>
      <NavigationHoldsPaused value={hidden}>
        <GoatBotChatHidden value={hidden}>
          <GoatBotMemberContext value={member}>
            <GoatBotChatView
              environmentId={env}
              availability={
                connecting
                  ? { kind: "connecting", environmentId: env }
                  : { kind: "ready", bot: { environmentId: env, threadId } }
              }
              canOperate
              rows={rows}
              onSend={onSend}
              onRetryInput={() => {}}
              legacyAgentRoute={null}
              attachmentSupport={{ maxUploadBytes: 1_000_000 }}
            />
          </GoatBotMemberContext>
        </GoatBotChatHidden>
      </NavigationHoldsPaused>
      <section aria-label="Task">
        <HiddenChatLine hidden={hidden} />
      </section>
    </div>
  );
}

async function draftWithFile(screen: Awaited<ReturnType<typeof render>>, box: string) {
  await userEvent.type(screen.getByRole("textbox", { name: box }), "ship it tonight");
  const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("expected the file picker");
  await userEvent.upload(input, new File(["launch"], "checklist.txt", { type: "text/plain" }));
  await expect
    .element(screen.getByRole("list", { name: "Attachments" }))
    .toHaveTextContent("checklist.txt");
}

it("regression #3393: a draft and its file in the main chat beside a task are dropped, not sent, when a member's task opens there", async () => {
  setup();
  const toMain = vi.fn(() => true);
  const toResearch = vi.fn(() => true);
  await using screen = await render(besideTask({ member: null, onSend: toMain }));
  await draftWithFile(screen, "Message GOAT Bot");
  // A Needs you ask or a member's task link: /bot?task=Y&bot=research, the same chat view.
  await screen.rerender(besideTask({ member: research, onSend: toResearch }));
  const box = screen.getByRole("textbox", { name: "Message Research" });
  await expect.element(box).toHaveValue("");
  await expect.element(screen.getByRole("list", { name: "Attachments" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Send", includeHidden: true }))
    .toBeDisabled();
  expect(released).toContainEqual(["checklist.txt"]);
  await userEvent.type(box, "{Enter}");
  expect(toResearch).not.toHaveBeenCalled();
  expect(toMain).not.toHaveBeenCalled();
});

it("guard: the same bot rendering again, or this chat view on its own going to connecting and back, keeps the draft and its file", async () => {
  setup();
  const toMain = vi.fn(() => true);
  await using screen = await render(besideTask({ member: null, onSend: toMain }));
  await draftWithFile(screen, "Message GOAT Bot");
  const note: GoatBotRow = {
    kind: "bot",
    id: "note",
    text: "Still working",
    createdAt: "2026-11-15T09:00:00Z",
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  };
  await screen.rerender(besideTask({ member: null, onSend: toMain, rows: [note] }));
  await screen.rerender(besideTask({ member: null, onSend: toMain, connecting: true }));
  await screen.rerender(besideTask({ member: null, onSend: toMain }));
  await expect
    .element(screen.getByRole("textbox", { name: "Message GOAT Bot" }))
    .toHaveValue("ship it tonight");
  await expect
    .element(screen.getByRole("list", { name: "Attachments" }))
    .toHaveTextContent("checklist.txt");
  expect(released).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(toMain).toHaveBeenCalledWith("ship it tonight", [
    expect.objectContaining({ name: "checklist.txt" }),
  ]);
});

it("regression #3393: with the chat hidden behind the task, the unsaved-work line goes once a member's task drops the draft", async () => {
  setup();
  const toMain = vi.fn(() => true);
  const toResearch = vi.fn(() => true);
  await using screen = await render(besideTask({ member: null, onSend: toMain }));
  await draftWithFile(screen, "Message GOAT Bot");
  // At 980px and below the task replaces the chat, which stays mounted with its draft.
  await screen.rerender(besideTask({ member: null, onSend: toMain, hidden: true }));
  const line = screen.getByRole("region", { name: "Task" }).getByRole("status");
  await expect.element(line).toHaveTextContent(UNSAVED_BEHIND);
  await screen.rerender(besideTask({ member: research, onSend: toResearch, hidden: true }));
  await expect.element(line).toHaveTextContent("");
  await screen.rerender(besideTask({ member: research, onSend: toResearch }));
  await expect.element(screen.getByRole("textbox", { name: "Message Research" })).toHaveValue("");
  expect(toResearch).not.toHaveBeenCalled();
});
