import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const member = vi.hoisted(() => ({
  shell: null as null | { updatedAt: string; lastVisitedAt?: string | null },
  latest: undefined as undefined | { text: string; at: string; author: "bot" | "person" },
  refresh: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: "connected" },
          serverConfig: { environment: { capabilities: { goatBotMembers: true } } },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/channels", () => ({ channelEnvironment: { botStatus: () => "status" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { waitingCount: 0, ...(member.latest ? { latest: member.latest } : {}) },
    refresh: member.refresh,
  }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => member.shell }));

import { useMobileMemberStatus } from "./useMobileMemberStatus";

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "scout-thread",
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
});

async function unread() {
  let value: boolean | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout).unread;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  return value;
}

it("marks a member's reply unread until a visit of its conversation reaches it", async () => {
  member.latest = { text: "Which machine?", at: "2026-11-11T10:05:00.000Z", author: "bot" };
  member.shell = {
    updatedAt: "2026-11-11T10:05:00.000Z",
    lastVisitedAt: "2026-11-11T10:01:00.000Z",
  };
  expect(await unread()).toBe(true);
  // The member's chat recorded the visit at its newest message.
  member.shell = {
    updatedAt: "2026-11-11T10:05:00.000Z",
    lastVisitedAt: "2026-11-11T10:05:00.000Z",
  };
  expect(await unread()).toBe(false);
});

it("never marks a member unread on a server that records no visits", async () => {
  member.latest = { text: "Hi, I'm Scout.", at: "2026-11-11T10:05:00.000Z", author: "bot" };
  member.shell = { updatedAt: "2026-11-11T10:05:00.000Z" };
  expect(await unread()).toBe(false);
});
