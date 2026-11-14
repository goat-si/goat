import { act } from "react";
import { createRoot } from "react-dom/client";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const member = vi.hoisted(() => ({
  shell: null as null | { updatedAt: string; lastVisitedAt?: string | null },
  latest: undefined as undefined | { text: string; at: string; author: "bot" | "person" },
  refresh: vi.fn(),
  // A refresh that failed after an earlier answer: the query keeps that answer beside the error.
  error: null as string | null,
  capabilities: {} as Record<string, boolean>,
}));
const visitAware = {
  goatBotMembers: true,
  goatBotStatus: true,
  goatBotWaitingRead: true,
  threadVisitedTracking: true,
};
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: "connected" },
          serverConfig: {
            environment: { capabilities: { ...visitAware, ...member.capabilities } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/channels", () => ({ channelEnvironment: { botStatus: () => "status" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { waitingCount: 0, ...(member.latest ? { latest: member.latest } : {}) },
    error: member.error,
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

function setup() {
  member.shell = null;
  member.latest = undefined;
  member.refresh.mockClear();
  member.error = null;
  member.capabilities = {};
}

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
  setup();
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
  setup();
  member.latest = { text: "Hi, I'm Scout.", at: "2026-11-11T10:05:00.000Z", author: "bot" };
  member.shell = { updatedAt: "2026-11-11T10:05:00.000Z" };
  expect(await unread()).toBe(false);
});

it("a waiting count whose latest read failed is unavailable, not the earlier answer", async () => {
  setup();
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout);
    return null;
  }
  const show = async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
  };
  member.error = null;
  await show();
  expect(value?.waitingState).toBe("ready");
  member.error = "failed";
  await show();
  expect(value?.waitingState).toBe("unavailable");
});

it("a waiting count from a server that cannot count by visit is unavailable", async () => {
  setup();
  let value: ReturnType<typeof useMobileMemberStatus> | undefined;
  function Probe() {
    value = useMobileMemberStatus(scout);
    return null;
  }
  for (const missing of ["goatBotStatus", "goatBotWaitingRead", "threadVisitedTracking"]) {
    member.capabilities = { [missing]: false };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    expect(value?.waitingState, missing).toBe("unavailable");
  }
});
