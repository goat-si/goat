import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { newBotSlot, startNewBot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make<unknown>({ isReady: true, entries: new Map() }),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("../../state/channels", () => ({ channelEnvironment: { listBots: () => null } }));
import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useComputerReadable,
  useKeptPerComputer,
} from "./useKeptPerComputer";

const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<unknown>;
const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const listed = (ids: string[]) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});

function following() {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(catalogAtom, listed(["env"]));
  return { registry, [Symbol.dispose]: stop };
}

const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const bot = (botId: string) =>
  decodeProfile({
    botId,
    role: "member",
    name: "New bot",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });

it("a connection refusal drops the created bots held for that computer, and a create answering later brings none back", async () => {
  using follow = following();
  const environmentId = EnvironmentId.make("env");
  const answers: Array<(bot: BotProfile) => void> = [];
  const create = () => new Promise<BotProfile>((resolve) => answers.push(resolve));
  startNewBot(
    environmentId,
    [],
    create,
    () => {},
    {},
    () => "first",
  );
  await act(async () => answers.shift()?.(bot("first")));
  startNewBot(
    environmentId,
    [],
    create,
    () => {},
    {},
    () => "second",
  );
  expect(newBotSlot(environmentId).created.map((held) => held.botId)).toEqual(["first"]);
  expect(newBotSlot(environmentId).operation?.phase).toBe("creating");
  follow.registry.set(
    presentationsAtom,
    new Map([
      [
        "env",
        { connection: { phase: "error", failure: { kind: "blocked", reason: "permission" } } },
      ],
    ]),
  );
  expect(newBotSlot(environmentId)).toMatchObject({ operation: null, created: [] });
  await act(async () => answers.shift()?.(bot("second")));
  expect(newBotSlot(environmentId)).toMatchObject({ operation: null, created: [] });
});

it("an open asks answer from before its computer was removed and added again is not kept", async () => {
  using follow = following();
  const { registry } = follow;
  const asks = { asks: [{ text: "Which machine?" }], total: 1, truncated: false };
  let kept: unknown = null;
  function Asks(props: { readonly online: boolean }) {
    const data = props.online ? asks : null;
    kept = useKeptPerComputer(
      "asks",
      EnvironmentId.make("env"),
      {
        data,
        successResult: null,
        cause: null,
        error: null,
        isPending: false,
        isSuccess: data !== null,
        refresh: () => {},
      },
      !props.online,
    );
    return null;
  }
  // Removed and added again after Needs you rendered its answer, before that render's effects ran.
  function RemoveAndReAddAfterRender() {
    useLayoutEffect(() => {
      registry.set(catalogAtom, listed([]));
      registry.set(catalogAtom, listed(["env"]));
    }, []);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <Asks online />
        <RemoveAndReAddAfterRender />
      </RegistryContext>,
    ),
  );
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <Asks online={false} />
      </RegistryContext>,
    ),
  );
  expect(kept).toBeNull();
  await act(async () => root.unmount());
});

type Read = AsyncResult.AsyncResult<unknown, unknown>;
const refusal = (previous: AsyncResult.Success<unknown, unknown>) =>
  AsyncResult.failure(
    Cause.fail({ _tag: "EnvironmentAuthorizationError", message: "Not allowed." }),
    { previousSuccess: Option.some(previous) },
  );
// Answers carry the time they settled; the clock stands still until a test moves it.
const T0 = Date.parse("2026-11-16T10:00:00.000Z");
function frozenClock() {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  return {
    later: () => vi.setSystemTime(T0 + 1_000),
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

/** One computer's read through the real query view, as a roster reader holds it. */
function reader(kind: "bots" | "asks", registry: AtomRegistry.AtomRegistry) {
  const read = Atom.make<Read>(AsyncResult.initial());
  const environmentId = EnvironmentId.make("env");
  let shown: unknown = null;
  let readable = false;
  function Reader() {
    shown = useKeptPerComputer(kind, environmentId, useEnvironmentQuery(read), false);
    readable = useComputerReadable(environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const mount = () =>
    act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Reader />
        </RegistryContext>,
      ),
    );
  return {
    get shown() {
      return shown;
    },
    get readable() {
      return readable;
    },
    mount,
    unmount: () => act(async () => root.render(<RegistryContext value={registry} />)),
    answer: (result: Read) => act(async () => registry.set(read, result)),
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

it("a refused bot list stays refused through a cached answer still waiting on its read", async () => {
  using clock = frozenClock();
  using follow = following();
  await using list = reader("bots", follow.registry);
  const before = AsyncResult.success({ bots: [] });
  await list.mount();
  await list.answer(before);
  await list.answer(refusal(before));
  expect(list.readable).toBe(false);
  clock.later();
  await list.answer(AsyncResult.success({ bots: [] }, { waiting: true }));
  expect(list.readable).toBe(false);
});

it("a refused bot list stays refused when its answer from before the refusal is delivered again, or on a remount", async () => {
  using clock = frozenClock();
  using follow = following();
  await using list = reader("bots", follow.registry);
  const before = AsyncResult.success({ bots: [] });
  await list.mount();
  await list.answer(before);
  await list.answer(refusal(before));
  clock.later();
  await list.answer(before);
  expect(list.readable).toBe(false);
  await list.unmount();
  await list.mount();
  expect(list.readable).toBe(false);
});

it("a bot list that settles after the refusal makes the computer readable again", async () => {
  using clock = frozenClock();
  using follow = following();
  await using list = reader("bots", follow.registry);
  const before = AsyncResult.success({ bots: [] });
  await list.mount();
  await list.answer(before);
  await list.answer(refusal(before));
  clock.later();
  await list.answer(AsyncResult.success({ bots: [] }));
  expect(list.readable).toBe(true);
});

it.each(["bots", "asks"] as const)(
  "%s: an answer that settled before its computer was removed and added again does not show after the re-add",
  async (kind) => {
    using clock = frozenClock();
    using follow = following();
    await using read = reader(kind, follow.registry);
    const before = AsyncResult.success(kind === "bots" ? { bots: [] } : { asks: [], total: 0 });
    await read.mount();
    await read.answer(before);
    expect(read.shown).toBe(before.value);
    await act(async () => {
      follow.registry.set(catalogAtom, listed([]));
      follow.registry.set(catalogAtom, listed(["env"]));
    });
    clock.later();
    // The query read again after the re-add still holds its earlier answer, marked waiting.
    await read.answer(AsyncResult.waiting(before));
    expect(read.shown).toBeNull();
    await read.answer(before);
    expect(read.shown).toBeNull();
    // The same content, answered again after the re-add, keeps its identity and shows.
    await read.answer(AsyncResult.success(before.value));
    expect(read.shown).toBe(before.value);
  },
);
