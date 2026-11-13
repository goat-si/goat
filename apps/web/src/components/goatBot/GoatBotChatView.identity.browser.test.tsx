import {
  EnvironmentId,
  ThreadId,
  type BotProfile,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";

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

import { GoatBotChatView } from "./GoatBotChatView";
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
