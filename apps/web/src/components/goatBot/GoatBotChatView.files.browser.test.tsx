import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import "~/index.css";

const state = vi.hoisted(() => ({ narrow: false, matched: 0, realTimeline: false }));
// The Library listing query, an object as the real atoms are.
const artifactsQuery = vi.hoisted(() => ({ query: "artifacts" }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
// The real reply file cards under a stand-in timeline, so the chat's file context reaches them.
vi.mock("./GoatBotTimeline", async (original) => {
  const { GoatBotReplyFiles } = await import("./GoatBotReplyFiles");
  const real = await original<typeof import("./GoatBotTimeline")>();
  return {
    ...real,
    GoatBotTimeline: (props: Parameters<typeof real.GoatBotTimeline>[0]) =>
      state.realTimeline ? (
        <real.GoatBotTimeline {...props} />
      ) : (
        <>
          <p>Earlier conversation</p>
          {props.rows.map((row) =>
            row.kind === "bot" ? <GoatBotReplyFiles key={row.id} text={row.text} /> : null,
          )}
        </>
      ),
  };
});
vi.mock("@goat/client-runtime/goatBot", async (original) => {
  const real = await original<typeof import("@goat/client-runtime/goatBot")>();
  return {
    ...real,
    goatBotReplyFiles: (...args: Parameters<typeof real.goatBotReplyFiles>) => {
      state.matched += 1;
      return real.goatBotReplyFiles(...args);
    },
  };
});
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
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
      listBotArtifacts: () => artifactsQuery,
      slackSettings: () => "slack",
    },
  };
});
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () =>
    new Map([["local", { environment: { capabilities: { goatBotLibrary: true } } }]]),
}));
const report = {
  relativePath: "reports/summary.md",
  size: 20,
  modifiedAt: "2026-11-07T10:00:00.000Z",
};
// The listing as settled once; the reply files' reread reads its identity.
const settledListing = { _tag: "Success", waiting: false };
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuerySelector: () => settledListing,
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === null
        ? null
        : atom === artifactsQuery
          ? { artifacts: [report], truncated: false }
          : atom === "slack"
            ? []
            : { tasks: [] },
    failure: null,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: () => async () => {
    const bytes = new TextEncoder().encode("# Weekly summary");
    return {
      _tag: "Success",
      value: {
        status: "chunk",
        relativePath: report.relativePath,
        mimeType: "text/markdown",
        size: bytes.length,
        offset: 0,
        bytesBase64: Base64.encode(bytes),
        version: "v1",
        done: true,
      },
    };
  },
}));

import { GoatBotChatView } from "./GoatBotChatView";

const environmentId = EnvironmentId.make("local");
const row: GoatBotRow = {
  kind: "bot",
  id: "reply-1",
  text: "Saved it.",
  createdAt: "2026-11-07T10:00:00.000Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
};

function view(
  threadId = "bot",
  rows: ReadonlyArray<GoatBotRow> = [row],
  source?: Parameters<typeof GoatBotChatView>[0]["source"],
) {
  return (
    <GoatBotChatView
      availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make(threadId) } }}
      canOperate
      rows={rows}
      source={source}
      onSend={() => {}}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
      attachmentSupport={{ maxUploadBytes: 1_000_000 }}
    />
  );
}

it("announces a reply while a file is open without repeating it on close", async () => {
  state.narrow = false;
  state.realTimeline = true;
  try {
    const baselineIds = new Set([row.id]);
    const source = (ids: string[]) => ({
      identity: "local:bot",
      baselineIds,
      sourceIds: new Set(ids.map((id) => TurnItemId.make(id))),
      committedSends: new Map<string, string>(),
    });
    await using screen = await render(view("bot", [row], source([row.id])));
    await openLibraryFile(screen);
    await expect.element(screen.getByRole("heading", { name: "Weekly summary" })).toBeVisible();
    const fresh = { ...row, id: "new", text: "New reply" };
    await screen.rerender(view("bot", [row, fresh], source([row.id, fresh.id])));
    const status = screen.container.querySelector<HTMLElement>("[data-goat-bot-reply-status]");
    if (!status) throw new Error("missing bot status");
    expect(status.textContent).toMatch(/GOAT Bot replied\.|New reply from GOAT Bot\./);
    expect(status.closest(".hidden, [hidden], [aria-hidden=true], [inert]")).toBeNull();
    const spoken = status.textContent;
    await userEvent.click(screen.getByRole("button", { name: "Close summary.md" }));
    expect(status.textContent).toBe(spoken);
  } finally {
    state.realTimeline = false;
  }
});

async function openLibraryFile(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  // The narrow layout puts the panel in a sheet outside the rendered container.
  await userEvent.click(page.getByRole("tab", { name: "Library" }));
  await userEvent.click(page.getByRole("button", { name: /summary\.md/ }));
}

it("a Library file opens in place of the conversation with the composer kept, and Close returns to the row", async () => {
  state.narrow = false;
  await using screen = await render(view());
  await openLibraryFile(screen);
  await expect.element(screen.getByRole("heading", { name: "Weekly summary" })).toBeVisible();
  await expect.element(screen.getByText("Earlier conversation")).not.toBeVisible();
  // The forced wide layout squeezes the column in the small test page, so check the composer is still there.
  await expect
    .element(screen.getByRole("textbox", { name: "Message GOAT Bot" }))
    .toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Close summary.md" }));
  await expect.element(screen.getByText("Earlier conversation")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /summary\.md/ })).toHaveFocus();
});

it("on a narrow screen the sheet closes for the file, and Close returns to the composer", async () => {
  state.narrow = true;
  await using screen = await render(view());
  await openLibraryFile(screen);
  await expect.element(page.getByRole("tab", { name: "Library" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("heading", { name: "Weekly summary" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByText("Earlier conversation")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Message GOAT Bot" })).toHaveFocus();
});

it("switching to another bot closes the open file instead of showing it over that bot's chat", async () => {
  state.narrow = false;
  await using screen = await render(view());
  await openLibraryFile(screen);
  await expect.element(screen.getByRole("heading", { name: "Weekly summary" })).toBeVisible();
  await screen.rerender(view("other-bot"));
  await expect.element(screen.getByText("Earlier conversation")).toBeVisible();
  await screen.rerender(view());
  await expect.element(screen.getByText("Earlier conversation")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Weekly summary" }).query()).toBeNull();
});

it("rendering the chat again does not match its replies against the Library again", async () => {
  state.narrow = false;
  state.matched = 0;
  const rows = [{ ...row, text: "Saved `reports/summary.md`." }];
  await using screen = await render(view("bot", rows));
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  const matched = state.matched;
  expect(matched).toBeGreaterThan(0);
  await screen.rerender(view("bot", rows));
  await screen.rerender(view("bot", rows));
  await screen.rerender(view("bot", rows));
  expect(state.matched).toBe(matched);
});
