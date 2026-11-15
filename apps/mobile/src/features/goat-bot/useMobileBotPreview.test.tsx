import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ lastVisitedAt: "2026-10-12T11:00:00.000Z" }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => state.items,
}));
// Each computer's connection; a refused one says why.
const connection = vi.hoisted(() => ({ failure: null as null | { kind: string; reason: string } }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection:
            connection.failure === null
              ? { phase: "connected" }
              : { phase: "error", failure: connection.failure },
        },
      ],
    ]),
  }),
}));
// The app's computers; "env" is listed unless a test removes it.
const catalog = vi.hoisted(() => ({
  atom: null as null | import("effect/reactivity").Atom.Writable<unknown>,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  catalog.atom = Atom.make<unknown>({ isReady: true, entries: new Map([["env", {}]]) });
  return { environmentCatalog: { catalogValueAtom: catalog.atom } };
});
import { useMobileBotPreview } from "./useMobileBotPreview";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useKeptPerComputer,
} from "./useKeptPerComputer";

const threadId = ThreadId.make("thread-bot");
function message(
  id: string,
  type: "assistant_message" | "user_message",
  text: string,
): OrchestrationV2ProjectedTurnItem {
  const time = DateTime.makeUnsafe("2026-10-12T12:00:00Z");
  const shared = {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    messageId: MessageId.make(`m-${id}`),
    text,
  };
  const item: OrchestrationV2TurnItem =
    type === "assistant_message"
      ? { ...shared, type, streaming: false }
      : {
          ...shared,
          type,
          inputIntent: "turn_start",
          attachments: [],
          createdBy: "user",
          creationSource: "mobile",
        };
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  };
}

async function previewOf(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  state.items = [...items];
  let preview: ReturnType<typeof useMobileBotPreview> = null;
  function Probe(props: { readonly onRead: (value: typeof preview) => void }) {
    props.onRead(
      useMobileBotPreview({
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread-bot"),
      }),
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe onRead={(value) => (preview = value)} />));
  await act(async () => root.unmount());
  return preview;
}

it("reads the roster's latest message as one plain line, without Markdown", async () => {
  expect(
    await previewOf([
      message("b1", "assistant_message", "## Status\n\n**Done.** See [PR #42](https://x.test/42)"),
    ]),
  ).toMatchObject({ text: "Status Done. See PR #42", unread: true });
  expect(
    await previewOf([message("u1", "user_message", "Run `vp test` then *ship*")]),
  ).toMatchObject({ text: "You: Run vp test then ship" });
});

const refused = { _tag: "EnvironmentAuthorizationError", message: "Not allowed." };
const listed = (ids: string[]) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});
const botList = { bots: [] };

/** The main tile's line in one registry that follows the app's computers, beside the roster's bot-list read. */
function mainTile() {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  // The app's connections, as the app hands them to the follower it installs.
  const connections = Atom.make<ReadonlyMap<string, object>>(new Map());
  const stop = followKeptPerComputerCatalog(registry, connections as never);
  registry.set(catalog.atom!, listed(["env"]));
  let preview: ReturnType<typeof useMobileBotPreview> = null;
  function Probe() {
    preview = useMobileBotPreview({ environmentId: EnvironmentId.make("env"), threadId });
    return null;
  }
  function BotList(props: { readonly cause: unknown; readonly offline: boolean }) {
    useKeptPerComputer(
      "bots",
      EnvironmentId.make("env"),
      {
        data: props.cause === null && !props.offline ? botList : null,
        successResult: null,
        cause: props.cause,
        error: null,
        isPending: false,
        isSuccess: props.cause === null && !props.offline,
        refresh: () => {},
      },
      props.offline,
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const view = (children: ReactNode) => (
    <RegistryContext value={registry}>{children}</RegistryContext>
  );
  return {
    get line() {
      return preview?.text ?? null;
    },
    show: (botList: { cause?: unknown; offline?: boolean } = {}) =>
      act(async () =>
        root.render(
          view(
            <>
              <BotList cause={botList.cause ?? null} offline={botList.offline ?? false} />
              <Probe />
            </>,
          ),
        ),
      ),
    setComputers: (ids: string[]) => act(async () => registry.set(catalog.atom!, listed(ids))),
    /** The computer's connection fails this way, whatever is on screen at the time. */
    fail: (failure: { kind: string; reason: string } | null) =>
      act(async () => {
        connection.failure = failure;
        registry.set(
          connections,
          new Map([
            [
              "env",
              {
                connection: failure === null ? { phase: "connected" } : { phase: "error", failure },
              },
            ],
          ]),
        );
      }),
    /** Only the main tile is on screen: no bot list, no member rows. */
    showTileAlone: () => act(async () => root.render(view(<Probe />))),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      stop();
    },
  };
}

it("the main tile keeps its line while its computer is offline", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  await using tile = mainTile();
  await tile.show();
  await tile.show({ offline: true });
  expect(tile.line).toBe("The build is waiting on you.");
});

it("the main tile shows no line once this phone is refused that computer's bot list, offline included, until a read succeeds", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  await using tile = mainTile();
  await tile.show();
  await tile.show({ cause: refused });
  expect(tile.line).toBeNull();
  await tile.show({ offline: true });
  expect(tile.line).toBeNull();
  await tile.show();
  expect(tile.line).toBe("The build is waiting on you.");
});

it("the main tile shows no line once its computer is removed from the app, though its messages are still cached", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  await using tile = mainTile();
  await tile.show();
  await tile.setComputers([]);
  await tile.show({ offline: true });
  expect(tile.line).toBeNull();
});

it("a phone whose access was revoked shows no line, even from a fresh start with the conversation only in its cache", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  // The computer refuses this phone's credential: the connection stops there, and no read runs.
  connection.failure = { kind: "blocked", reason: "authentication" };
  try {
    await using tile = mainTile();
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    connection.failure = { kind: "blocked", reason: "permission" };
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
  } finally {
    connection.failure = null;
  }
});

it("a refusal stays known after the next attempt fails some other way, until a read succeeds", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  try {
    await using tile = mainTile();
    await tile.show();
    connection.failure = { kind: "blocked", reason: "authentication" };
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    // The network changed and the next attempt could not reach the computer: it never asked again.
    connection.failure = { kind: "retrying", reason: "host-unreachable" };
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    // Connected again and the bot list answered: this phone may read the computer.
    connection.failure = null;
    await tile.show();
    expect(tile.line).toBe("The build is waiting on you.");
  } finally {
    connection.failure = null;
  }
});

it("a refusal seen while no bot list is on screen still hides the line when the roster opens", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  try {
    await using tile = mainTile();
    // The phone sits on another screen while the computer refuses it, then fails to reach it.
    await tile.fail({ kind: "blocked", reason: "authentication" });
    await tile.fail({ kind: "retrying", reason: "host-unreachable" });
    await tile.showTileAlone();
    expect(tile.line).toBeNull();
  } finally {
    connection.failure = null;
  }
});
