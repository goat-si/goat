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
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
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
// Each computer's presentation, as the app derives it: its connection and what its server supports.
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
// The one bot-list read every reader of a computer shares; each test drives what it answers.
vi.mock("../../state/channels", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const read = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  return { channelEnvironment: { listBots: () => read } };
});
import { useMobileBotPreview } from "./useMobileBotPreview";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useKeptPerComputer,
} from "./useKeptPerComputer";
import { useEnvironmentQuery } from "../../state/query";
import { channelEnvironment } from "../../state/channels";
import { environmentPresentations } from "../../state/presentation";

const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const botListAtom = channelEnvironment.listBots({
  environmentId: EnvironmentId.make("env"),
  input: {},
}) as unknown as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>>;

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
const linked = (connection: object, capabilities: object = {}) =>
  new Map([["env", { connection, serverConfig: { environment: { capabilities } } }]]);

/** The main tile's line in one registry that follows the app's computers, beside the roster's bot-list read. */
function mainTile() {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
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
  let listOpen = false;
  const render = (botList: { cause?: unknown; offline?: boolean }) =>
    root.render(
      view(
        <>
          <BotList cause={botList.cause ?? null} offline={botList.offline ?? false} />
          <Probe />
        </>,
      ),
    );
  return {
    get line() {
      return preview?.text ?? null;
    },
    show: (botList: { cause?: unknown; offline?: boolean } = {}) =>
      act(async () => {
        listOpen = true;
        render(botList);
      }),
    setComputers: (ids: string[]) => act(async () => registry.set(catalog.atom!, listed(ids))),
    /**
     * The computer's connection fails this way, whatever is on screen. As in the app, the same
     * update takes an open bot list offline, so it reads nothing from then on.
     */
    fail: (failure: { kind: string; reason: string } | null) =>
      act(async () => {
        connection.failure = failure;
        registry.set(
          presentationsAtom,
          linked(failure === null ? { phase: "connected" } : { phase: "error", failure }),
        );
        if (listOpen && failure !== null) render({ offline: true });
      }),
    /** The computer's connection is under way again after a failure; nothing is read yet. */
    reconnecting: () =>
      act(async () => registry.set(presentationsAtom, linked({ phase: "connecting" }))),
    /** Only the main tile is on screen: no bot list, no member rows. */
    showTileAlone: () =>
      act(async () => {
        listOpen = false;
        root.render(view(<Probe />));
      }),
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
  try {
    await using tile = mainTile();
    // The computer refuses this phone's credential: the connection stops there, and no read runs.
    await tile.fail({ kind: "blocked", reason: "authentication" });
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    await tile.fail({ kind: "blocked", reason: "permission" });
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
  } finally {
    connection.failure = null;
  }
});

it("a refusal stays known after the next attempt fails some other way, until the computer connects again", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  try {
    await using tile = mainTile();
    await tile.show();
    await tile.fail({ kind: "blocked", reason: "authentication" });
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    // The network changed and the next attempt could not reach the computer: it never asked again.
    await tile.fail({ kind: "retrying", reason: "host-unreachable" });
    await tile.show({ offline: true });
    expect(tile.line).toBeNull();
    // Connected again and the bot list answered: this phone may read the computer.
    await tile.fail(null);
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

it("a reader outside the roster shows no line in any render after a refused bot list arrives", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(catalog.atom!, listed(["env"]));
  registry.set(presentationsAtom, linked({ phase: "connected" }, { goatBotProfiles: true }));
  registry.set(botListAtom, AsyncResult.success(botList));
  const environmentId = EnvironmentId.make("env");
  const lines: Array<{ readonly afterRefusal: boolean; readonly line: string | null }> = [];
  let afterRefusal = false;
  // As the bot chat route reads them in one component: the shared bot list, then the line.
  function Route() {
    useKeptPerComputer("bots", environmentId, useEnvironmentQuery(botListAtom), false);
    const line = useMobileBotPreview({ environmentId, threadId })?.text ?? null;
    lines.push({ afterRefusal, line });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <Route />
      </RegistryContext>,
    ),
  );
  expect(lines.at(-1)?.line).toBe("The build is waiting on you.");
  await act(async () => {
    afterRefusal = true;
    registry.set(
      botListAtom,
      AsyncResult.failure(Cause.fail(refused), {
        previousSuccess: Option.some(AsyncResult.success(botList)),
      }),
    );
  });
  const after = lines.filter((render) => render.afterRefusal).map((render) => render.line);
  expect(after.length).toBeGreaterThan(0);
  expect(after).toEqual(after.map(() => null));
  await act(async () => root.unmount());
  stop();
});

it("a connection refusal clears once the computer connects again, with no bot-list read at all", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  try {
    await using tile = mainTile();
    await tile.showTileAlone();
    await tile.fail({ kind: "blocked", reason: "authentication" });
    expect(tile.line).toBeNull();
    // A server without bot profiles is never asked for a bot list: connecting is the sign.
    await tile.fail(null);
    expect(tile.line).toBe("The build is waiting on you.");
  } finally {
    connection.failure = null;
  }
});

it("a bot list that answers does not clear a connection refusal; connecting again does", async () => {
  state.items = [message("b1", "assistant_message", "The build is waiting on you.")];
  try {
    await using tile = mainTile();
    await tile.show();
    await tile.fail({ kind: "blocked", reason: "authentication" });
    expect(tile.line).toBeNull();
    await tile.reconnecting();
    await tile.show();
    expect(tile.line).toBeNull();
    await tile.fail(null);
    expect(tile.line).toBe("The build is waiting on you.");
  } finally {
    connection.failure = null;
  }
});
