import { act, useLayoutEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
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
// Each read is a stand-in query a test makes; the follower refreshes these same atoms.
const queries = vi.hoisted(() => ({}) as Record<"bots" | "botsActive" | "asks", { atom: unknown }>);
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    listBots: (target: { input: { includeDeleted?: boolean } }) =>
      queries[target.input.includeDeleted === true ? "bots" : "botsActive"].atom,
  },
}));
vi.mock("./openAsksRead", () => ({ openAsks: () => queries.asks.atom }));
import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { startOver } from "./keptPerComputerStore";
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
  Object.assign(queries, { bots: query(), botsActive: query(), asks: query() });
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
const refusal = (previous?: AsyncResult.Success<unknown, unknown>) =>
  AsyncResult.failure(
    Cause.fail({ _tag: "EnvironmentAuthorizationError", message: "Not allowed." }),
    previous === undefined ? undefined : { previousSuccess: Option.some(previous) },
  );

// Time passes before every answer lands, as it does between a request and its answer.
const T0 = Date.parse("2026-11-16T10:00:00.000Z");
let now = T0;
const later = () => vi.setSystemTime((now += 1_000));

/**
 * A stand-in query. Each build is one request, showing the last answer marked waiting until it
 * answers; a refresh starts a new request, and the one it replaced lands nowhere.
 */
function query() {
  let requests = 0;
  const atom = Atom.writable(
    (get): Read => {
      requests += 1;
      return AsyncResult.waitingFrom(get.self<Read>());
    },
    (ctx, value: Read) => ctx.setSelf(value),
  ).pipe(Atom.keepAlive);
  return {
    atom,
    get requests() {
      return requests;
    },
    answer: (registry: AtomRegistry.AtomRegistry, value: Read, request = requests) =>
      act(async () => {
        later();
        const landed = AsyncResult.isSuccess(value)
          ? AsyncResult.success(value.value, { waiting: value.waiting })
          : value;
        if (request === requests) registry.set(atom, landed);
      }),
  };
}

/** A computer in the catalog with fresh reads, and the way to change its connection. */
function computer() {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  const follow = following();
  const reads = { bots: queries.bots, botsActive: queries.botsActive, asks: queries.asks } as {
    [Kind in "bots" | "botsActive" | "asks"]: ReturnType<typeof query>;
  };
  const link = (phase: "connected" | "refused") =>
    act(async () =>
      follow.registry.set(
        presentationsAtom,
        new Map([
          [
            "env",
            {
              connection:
                phase === "connected"
                  ? { phase }
                  : { phase: "error", failure: { kind: "blocked", reason: "authentication" } },
              serverConfig: {
                environment: { capabilities: { goatBotProfiles: true, goatBotMembers: true } },
              },
            },
          ],
        ]),
      ),
    );
  return {
    registry: follow.registry,
    ...reads,
    link,
    [Symbol.dispose]: () => {
      follow[Symbol.dispose]();
      vi.useRealTimers();
    },
  };
}

/** One reader of the computer through the real query view, as a roster reader holds it. */
function reader(kind: "bots" | "asks", registry: AtomRegistry.AtomRegistry, read: Atom.Atom<Read>) {
  const environmentId = EnvironmentId.make("env");
  let shown: unknown = null;
  let readable = false;
  function Reader() {
    shown = useKeptPerComputer(kind, environmentId, useEnvironmentQuery(read), false);
    readable = useComputerReadable(environmentId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    get shown() {
      return shown;
    },
    get readable() {
      return readable;
    },
    mount: () =>
      act(async () =>
        root.render(
          <RegistryContext value={registry}>
            <Reader />
          </RegistryContext>,
        ),
      ),
    unmount: () => act(async () => root.render(<RegistryContext value={registry} />)),
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

const someBots = () => AsyncResult.success({ bots: [] });

it("a refusal starts no request that could be refused again: a refused list reads the asks again once, a refused connection each read once", async () => {
  using env = computer();
  await env.link("connected");
  await using bots = reader("bots", env.registry, env.bots.atom);
  await using asks = reader("asks", env.registry, env.asks.atom);
  await bots.mount();
  await asks.mount();
  await env.bots.answer(env.registry, someBots());
  await env.asks.answer(env.registry, AsyncResult.success({ asks: [], total: 0 }));
  const requests = () => ({ bots: env.bots.requests, asks: env.asks.requests });
  const before = requests();
  await env.bots.answer(env.registry, refusal());
  await act(async () => {});
  expect(requests()).toEqual({ bots: before.bots, asks: before.asks + 1 });
  // The connection is refused too, and the computer goes on refusing whatever it is asked.
  await env.link("refused");
  await env.bots.answer(env.registry, refusal());
  await act(async () => {});
  expect(requests()).toEqual({ bots: before.bots + 1, asks: before.asks + 2 });
});

it("an answer that lands in the same step as a connection refusal does not show after the reconnect", async () => {
  using env = computer();
  await env.link("connected");
  await using bots = reader("bots", env.registry, env.bots.atom);
  await bots.mount();
  await env.bots.answer(env.registry, someBots());
  const inStep = someBots();
  await act(async () => {
    env.registry.set(env.bots.atom, inStep);
    env.registry.set(
      presentationsAtom,
      new Map([
        [
          "env",
          { connection: { phase: "error", failure: { kind: "blocked", reason: "permission" } } },
        ],
      ]),
    );
  });
  await env.link("connected");
  expect(bots.shown).toBeNull();
  expect(bots.readable).toBe(false);
  const fresh = someBots();
  await env.bots.answer(env.registry, fresh);
  expect(bots.shown).toBe(fresh.value);
});

it("after a connection refusal, the answer it found stays hidden on a remount and for a second reader that mounts later", async () => {
  using env = computer();
  await env.link("connected");
  await using first = reader("bots", env.registry, env.bots.atom);
  await first.mount();
  await env.bots.answer(env.registry, someBots());
  await env.link("refused");
  await env.link("connected");
  await first.unmount();
  await first.mount();
  expect(first.shown).toBeNull();
  await using second = reader("bots", env.registry, env.bots.atom);
  await second.mount();
  expect(second.shown).toBeNull();
  const fresh = someBots();
  await env.bots.answer(env.registry, fresh);
  expect({ first: first.shown, second: second.shown }).toEqual({
    first: fresh.value,
    second: fresh.value,
  });
});

it("a refused bot list stays refused through a cached answer still waiting on its read", async () => {
  using env = computer();
  await env.link("connected");
  await using list = reader("bots", env.registry, env.bots.atom);
  await list.mount();
  const before = someBots();
  await env.bots.answer(env.registry, before);
  await env.bots.answer(env.registry, refusal(before));
  expect(list.readable).toBe(false);
  await env.bots.answer(env.registry, AsyncResult.success({ bots: [] }, { waiting: true }));
  expect(list.readable).toBe(false);
});

it("a refused bot list shows nothing of its answer from before the refusal, also after a remount", async () => {
  using env = computer();
  await env.link("connected");
  await using list = reader("bots", env.registry, env.bots.atom);
  await list.mount();
  const before = someBots();
  await env.bots.answer(env.registry, before);
  await env.bots.answer(env.registry, refusal(before));
  expect({ shown: list.shown, readable: list.readable }).toEqual({ shown: null, readable: false });
  await list.unmount();
  await list.mount();
  expect({ shown: list.shown, readable: list.readable }).toEqual({ shown: null, readable: false });
});

it("a bot list that settles after the refusal makes the computer readable again", async () => {
  using env = computer();
  await env.link("connected");
  await using list = reader("bots", env.registry, env.bots.atom);
  await list.mount();
  const before = someBots();
  await env.bots.answer(env.registry, before);
  await env.bots.answer(env.registry, refusal(before));
  await env.bots.answer(env.registry, someBots());
  expect(list.readable).toBe(true);
});

it("a read in flight across a connection refusal that answers after it does not show after the reconnect", async () => {
  using env = computer();
  await env.link("connected");
  await using list = reader("bots", env.registry, env.bots.atom);
  await list.mount();
  const inFlight = env.bots.requests;
  await env.link("refused");
  await env.bots.answer(env.registry, someBots(), inFlight);
  await env.link("connected");
  expect(list.shown).toBeNull();
});

it.each(["bots", "asks"] as const)(
  "%s: an answer from before its computer was removed and added again does not show after the re-add",
  async (kind) => {
    using env = computer();
    await env.link("connected");
    // The roster's bot list, which says whether this computer may be read at all.
    await using roster = reader("bots", env.registry, env.bots.atom);
    await using read = reader(kind, env.registry, env[kind].atom);
    await roster.mount();
    await read.mount();
    await env.bots.answer(env.registry, someBots());
    const before = AsyncResult.success(kind === "bots" ? { bots: [] } : { asks: [], total: 0 });
    await env[kind].answer(env.registry, before);
    expect(read.shown).toBe(before.value);
    await act(async () => {
      env.registry.set(catalogAtom, listed([]));
      env.registry.set(catalogAtom, listed(["env"]));
    });
    expect(read.shown).toBeNull();
    if (kind === "asks") await env.bots.answer(env.registry, someBots());
    await env[kind].answer(env.registry, AsyncResult.success(before.value));
    expect(read.shown).toBe(before.value);
  },
);

it.each(["bots", "asks"] as const)(
  "%s: a read in flight across a removal and re-add does not show after the re-add",
  async (kind) => {
    using env = computer();
    await env.link("connected");
    await using read = reader(kind, env.registry, env[kind].atom);
    await read.mount();
    const inFlight = env[kind].requests;
    await act(async () => {
      env.registry.set(catalogAtom, listed([]));
      env.registry.set(catalogAtom, listed(["env"]));
    });
    await env[kind].answer(env.registry, AsyncResult.success({ bots: [], asks: [] }), inFlight);
    expect(read.shown).toBeNull();
  },
);

it.each(["bots", "asks"] as const)(
  "%s: a second restart between an answer's render and its effect keeps the read starting over",
  async (kind) => {
    using env = computer();
    await env.link("connected");
    const read = env[kind];
    const environmentId = EnvironmentId.make("env");
    let shown: unknown = null;
    let restarted = false;
    function Reader() {
      shown = useKeptPerComputer(kind, environmentId, useEnvironmentQuery(read.atom), false);
      return null;
    }
    // Renders in the same commit as the reader; its layout effect runs before the reader's passive
    // effect, so a restart here lands after the reader saw the answer and before it acts on it.
    function RestartOnAnswer() {
      const result = useAtomValue(read.atom);
      useLayoutEffect(() => {
        if (restarted || result._tag !== "Success" || result.waiting) return;
        restarted = true;
        startOver(env.registry, environmentId, kind);
      }, [result]);
      return null;
    }
    // For asks, the roster's bot list, which must answer after the re-add before they show. It
    // shares the root, so every effect of a commit runs in one pass, as in the app.
    function RosterList() {
      useKeptPerComputer("bots", environmentId, useEnvironmentQuery(env.bots.atom), false);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        <RegistryContext value={env.registry}>
          {kind === "asks" ? <RosterList /> : null}
          <Reader />
          <RestartOnAnswer />
        </RegistryContext>,
      ),
    );
    // Restart 1: the computer is removed and added again.
    await act(async () => {
      env.registry.set(catalogAtom, listed([]));
      env.registry.set(catalogAtom, listed(["env"]));
    });
    if (kind === "asks") await env.bots.answer(env.registry, someBots());
    const first = AsyncResult.success(kind === "bots" ? { bots: [] } : { asks: [], total: 0 });
    await read.answer(env.registry, first);
    expect(restarted).toBe(true);
    // Restart 2 is still waiting on its answer: restart 1's, now a waiting copy, shows nothing.
    expect(shown).toBeNull();
    const second = AsyncResult.success(kind === "bots" ? { bots: [] } : { asks: [], total: 0 });
    await read.answer(env.registry, second);
    expect(shown).toBe(second.value);
    await act(async () => root.unmount());
  },
);

it("a bot list refused while the computer is starting over still restarts asks that answered since", async () => {
  using env = computer();
  await env.link("connected");
  await using roster = reader("bots", env.registry, env.bots.atom);
  await using needsYou = reader("asks", env.registry, env.asks.atom);
  await roster.mount();
  await needsYou.mount();
  await act(async () => {
    env.registry.set(catalogAtom, listed([]));
    env.registry.set(catalogAtom, listed(["env"]));
  });
  // The asks answer after the re-add, then the bot list is refused before it ever answered.
  const earlier = AsyncResult.success({ asks: [], total: 0 });
  await env.asks.answer(env.registry, earlier);
  await env.bots.answer(env.registry, refusal());
  // Access comes back: the list answers. The asks from before its refusal do not show.
  await env.bots.answer(env.registry, someBots());
  expect(needsYou.shown).toBeNull();
  const fresh = AsyncResult.success({ asks: [], total: 0 });
  await env.asks.answer(env.registry, fresh);
  expect(needsYou.shown).toBe(fresh.value);
});
