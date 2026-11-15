import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { turnItem } from "./GoatBotChatView.sync.fixtures";

import "~/index.css";

// How many times Home's routine list and a routine's run strip have rendered.
const probe = vi.hoisted(() => ({ routines: 0, strips: 0 }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
// A wide window, so Home docks beside the chat.
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
// Run times read the same in any runner.
vi.mock("~/timestampFormat", async (original) => ({
  ...(await original<typeof import("~/timestampFormat")>()),
  timestampLocale: "en-US",
}));
vi.mock("./useBotRoster", () => ({
  useBotThreads: () => ({
    rows: [],
    supported: true,
    loaded: true,
    failed: false,
    turnsWaiting: [],
    chips: new Map(),
    refresh: () => {},
  }),
}));
vi.mock("./GoatBotRoutines", async (original) => {
  const real = await original<typeof import("./GoatBotRoutines")>();
  return {
    ...real,
    GoatBotRoutines: (props: Parameters<typeof real.GoatBotRoutines>[0]) => {
      probe.routines += 1;
      return <real.GoatBotRoutines {...props} />;
    },
  };
});
vi.mock("./GoatBotRoutineRuns", async (original) => {
  const real = await original<typeof import("./GoatBotRoutineRuns")>();
  return {
    ...real,
    GoatBotRoutineRuns: (props: Parameters<typeof real.GoatBotRoutineRuns>[0]) => {
      probe.strips += 1;
      return <real.GoatBotRoutineRuns {...props} />;
    },
  };
});
vi.mock("~/state/server", async (original) => {
  const real = await original<typeof import("~/state/server")>();
  return {
    ...real,
    serverEnvironment: { ...real.serverEnvironment, scheduledTasksLive: () => "routines" },
  };
});
vi.mock("~/state/channels", async (original) => {
  const real = await original<typeof import("~/state/channels")>();
  return {
    ...real,
    channelEnvironment: {
      ...real.channelEnvironment,
      listBotNotes: () => "notes",
      listBotArtifacts: () => "artifacts",
      slackSettings: () => "slack",
      getInput: (key: { input: { inputId: string } }) => `input:${key.input.inputId}`,
    },
  };
});
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", async (original) => {
  const { routine } = await import("./GoatBotChatView.routines.fixtures");
  // One answer per query, kept between renders as the real atoms keep theirs.
  const answers = new Map<unknown, unknown>();
  const answerFor = (atom: unknown) => ({
    data:
      atom === null
        ? null
        : atom === "routines"
          ? { tasks: [routine] }
          : atom === "input:in-1"
            ? { reply: { text: "Morning digest: all green." } }
            : atom === "artifacts"
              ? { artifacts: [], truncated: false }
              : atom === "slack"
                ? []
                : { tasks: [] },
    failure: null,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  });
  return {
    ...(await original<typeof import("~/state/query")>()),
    useEnvironmentQuerySelector: () => ({ _tag: "Success", waiting: false }),
    useEnvironmentQuery: (atom: unknown) => {
      if (!answers.has(atom)) answers.set(atom, answerFor(atom));
      return answers.get(atom);
    },
  };
});

import { GoatBotChatView } from "./GoatBotChatView";

function setup() {
  probe.routines = 0;
  probe.strips = 0;
}

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("bot");
const at = "2026-11-14T09:00:00.000Z";
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const bot = (id: string, text: string): Extract<GoatBotRow, { kind: "bot" }> => ({
  kind: "bot",
  id,
  text,
  createdAt: at,
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
function item(id: string, text: string, ordinal: number, inReplyTo?: string) {
  const decoded = decodeItem({
    ...turnItem(threadId, id, "assistant", text, ordinal),
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    channel: {
      conversationId: "conv",
      originKind: "goat",
      kind: "receipt",
      ...(inReplyTo === undefined ? {} : { inReplyToInputId: inReplyTo }),
    },
  });
  return {
    position: ordinal,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: decoded.id,
    item: decoded,
  } satisfies OrchestrationV2ProjectedTurnItem;
}
const earlier = bot("earlier", "Earlier message");
const reply = bot("reply-1", "Morning digest: all green.");

/** The chat as a streamed update leaves it: new rows, items and task reader every time. */
function view(
  rows: ReadonlyArray<GoatBotRow>,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  return (
    // Home docks only in a chat view of 752px or more.
    <div style={{ width: 1200, height: 700, display: "flex" }}>
      <GoatBotChatView
        availability={{ kind: "ready", bot: { environmentId, threadId } }}
        canOperate
        rows={rows}
        visibleTurnItems={items}
        rowsForTask={() => rows}
        onSend={() => {}}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
    </div>
  );
}
const dot = () => page.getByRole("button", { name: "Run on Nov 14, 9:00 AM, completed" });
const popup = () => page.getByRole("dialog");

it("a chat update does not redraw a routine row when no popover is open", async () => {
  setup();
  const first = bot("first", "Streamed first");
  const second = bot("second", "Streamed second");
  await using screen = await render(view([earlier], []));
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(dot()).toBeVisible();
  // The first update lets mount-time renders settle; the second is the one measured.
  await screen.rerender(view([earlier, first], [item("first", first.text, 1)]));
  await expect.element(screen.getByText("Streamed first")).toBeVisible();
  const settled = { ...probe };
  await screen.rerender(
    view([earlier, first, second], [item("first", first.text, 1), item("second", second.text, 2)]),
  );
  await expect.element(screen.getByText("Streamed second")).toBeVisible();
  expect(probe).toEqual(settled);
});

it("an open run gains Show in chat when its reply arrives in the chat", async () => {
  setup();
  await using screen = await render(view([earlier], []));
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(dot());
  await expect.element(popup()).toMatchTextContent("Morning digest: all green.");
  const offer = () => popup().getByRole("button", { name: "Show in chat" });
  expect(offer().query()).toBeNull();
  await screen.rerender(view([earlier, reply], [item("reply-1", reply.text, 1, "in-1")]));
  await expect.element(offer()).toBeVisible();
  await userEvent.click(offer());
  await expect.element(popup()).not.toBeInTheDocument();
  expect(document.activeElement?.getAttribute("data-bot-row")).toBe("reply-1");
});
