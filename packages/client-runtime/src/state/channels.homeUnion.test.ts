import { BotId, BotThreadRow, EnvironmentId, type ServerConfig } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as Cause from "effect/Cause";
import { homeWorkGoverns } from "../goatBot/homeCurrentOpenableWork.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

const env = EnvironmentId.make("source");
const now = Date.parse("2026-11-04T12:00:00Z");
const capabilities = {
  goatBotTaskThreads: true,
  goatBotTaskThreadsPaged: true,
  goatBotTaskLookupSearch: true,
  goatBotMembers: true,
  goatBotProfiles: true,
};
const config = Atom.make({
  environment: { environmentId: env, capabilities },
} as unknown as ServerConfig);
const connection = Atom.make(
  AsyncResult.success([{ phase: "connected" }, Option.some({})] as const),
);
const bots = Atom.make(
  AsyncResult.success({
    bots: [
      { botId: BotId.make("member"), role: "member", state: "active" },
      { botId: BotId.make("deleted"), role: "member", state: "deleted" },
    ],
  }),
);
const decode = Schema.decodeSync(BotThreadRow);
const row = (id: string, completed = false) =>
  decode({
    kind: "task",
    task: {
      taskId: id,
      title: id,
      status: completed ? "completed" : "running",
      updatedAt: id === "member" ? "2026-11-01T14:00:00Z" : "2026-11-01T13:00:00Z",
      ...(completed
        ? { completedAt: id === "member" ? "2026-11-01T14:00:00Z" : "2026-11-01T13:00:00Z" }
        : {}),
    },
    view: {
      taskId: id,
      pinnedAt: null,
      doneAt: completed
        ? id === "member"
          ? "2026-11-01T14:00:00Z"
          : "2026-11-01T13:00:00Z"
        : null,
      readThrough: null,
    },
    lastActivityAt: "2026-11-01T13:00:00Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
    worker: { environmentId: "source", threadId: id },
  });
const state = vi.hoisted(() => ({
  reads: 0,
  byBot: {} as Record<string, number>,
  completed: false,
  failing: {} as Record<string, boolean>,
}));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => config }),
}));
vi.mock("./environmentConnections.ts", () => ({
  environmentConnectionAtoms: () => () => connection,
}));
vi.mock("./commandPermissions.ts", () => ({
  createCommandPermissions: () => ({ permissionAtom: () => Atom.make(true) }),
}));
vi.mock("./runtime.ts", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { fail } = await import("effect/Cause");
  return {
    createEnvironmentRpcCommand: () => ({}),
    createEnvironmentRpcSubscriptionAtomFamily: () => () => A.make(null),
    createEnvironmentSubscriptionAtomFamily: () => () => A.make(null),
    createEnvironmentRpcQueryAtomFamily: (
      _runtime: unknown,
      options: { tag: string; refreshTrigger?: (target: unknown) => Atom.Atom<unknown> },
    ) => {
      const family = A.family((key: string) => {
        const target = JSON.parse(key) as { input: { botId?: string } };
        const trigger = options.refreshTrigger?.(target);
        return A.make((get) => {
          if (options.tag === "channel.listBots") return get(bots);
          if (trigger) get(trigger);
          state.reads++;
          const id = target.input.botId ?? "main";
          state.byBot[id] = (state.byBot[id] ?? 0) + 1;
          if (state.failing[id]) return R.failure(fail("offline"));
          return R.success({
            rows: [row(target.input.botId ?? "main", state.completed)],
            mainMessageCount: 0,
          });
        });
      });
      return (target: unknown) => family(JSON.stringify(target));
    },
  };
});
const setup = () => {
  const registry = AtomRegistry.make();
  const atoms = createChannelEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"])),
  );
  const union = atoms.homeCurrentOpenableWorkByEnvironment(env);
  registry.mount(union);
  return { registry, union };
};
it("unions main and active members only when both member capabilities exist", () => {
  vi.useFakeTimers({ now });
  state.completed = false;
  const { registry, union } = setup();
  expect(registry.get(union).links.map((link) => link.threadId)).toEqual(["main", "member"]);
  for (const missing of ["goatBotMembers", "goatBotProfiles"] as const) {
    registry.set(config, {
      environment: { environmentId: env, capabilities: { ...capabilities, [missing]: false } },
    } as unknown as ServerConfig);
    expect(registry.get(union).links.map((link) => link.threadId)).toEqual(["main"]);
  }
  registry.dispose();
  vi.useRealTimers();
});
it("governs lists only once the member roster has been read", () => {
  vi.useFakeTimers({ now });
  state.completed = false;
  const { registry, union } = setup();
  expect(homeWorkGoverns(registry.get(union))).toBe(true);
  for (const roster of [AsyncResult.initial(true), AsyncResult.failure(Cause.fail("offline"))]) {
    registry.set(bots, roster as never);
    expect(registry.get(union).byBot.map((bot) => bot.botId)).toEqual(["main"]);
    expect(homeWorkGoverns(registry.get(union))).toBe(false);
  }
  registry.set(bots, AsyncResult.success({ bots: [] }) as never);
  expect(homeWorkGoverns(registry.get(union))).toBe(true);
  registry.dispose();
  vi.useRealTimers();
});

it("retires links and requests a fresh list when retention ends", () => {
  vi.useFakeTimers({ now });
  state.completed = true;
  const { registry, union } = setup();
  expect(registry.get(union).links).toHaveLength(2);
  const reads = state.reads;
  vi.advanceTimersByTime(3_600_000);
  expect(registry.get(union).links).toHaveLength(1);
  expect(state.reads).toBeGreaterThan(reads);
  registry.dispose();
  vi.useRealTimers();
});

const watchRetentionTimers = () => {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const start = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    let handle: ReturnType<typeof setTimeout>;
    // @effect-diagnostics-next-line globalTimers:off - Track the fake retention timers under test.
    handle = start(() => {
      pending.delete(handle);
      callback();
    }, delay);
    if ((delay ?? 0) >= 5_000) pending.add(handle);
    return handle;
  }) as typeof setTimeout);
  const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    pending.delete(handle as ReturnType<typeof setTimeout>);
    cancel(handle);
  });
  return {
    count: () => pending.size,
    restore: () => {
      clearSpy.mockRestore();
      setSpy.mockRestore();
    },
  };
};
it("shares one timer and rereads only the expiring bot across all consumers", () => {
  vi.useFakeTimers({ now });
  const timers = watchRetentionTimers();
  state.completed = true;
  state.byBot = {};
  const registry = AtomRegistry.make();
  const atoms = createChannelEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"])),
  );
  registry.set(config, {
    environment: { environmentId: env, capabilities },
  } as unknown as ServerConfig);
  const union = atoms.homeCurrentOpenableWorkByEnvironment(env);
  const perBot = atoms.homeCurrentOpenableWorkAtom([env, BotId.make("main")]);
  const listed = atoms.listedBotWork({
    environmentIdsAtom: Atom.make([env]),
    signal: () => Atom.make(""),
  });
  const stopUnion = registry.mount(union);
  const stopBot = registry.mount(perBot);
  const stopListed = registry.mount(listed);
  registry.get(union);
  registry.get(perBot);
  registry.get(listed);
  expect(timers.count()).toBe(2);
  const mainReads = state.byBot.main ?? 0;
  const memberReads = state.byBot.member;
  vi.advanceTimersByTime(3_600_000);
  registry.get(union);
  registry.get(perBot);
  registry.get(listed);
  expect(state.byBot.main).toBe(mainReads + 1);
  expect(state.byBot.member).toBe(memberReads);
  stopListed();
  stopBot();
  stopUnion();
  registry.dispose();
  expect(timers.count()).toBe(0);
  timers.restore();
  vi.useRealTimers();
});
it("releases member timers on deletion and all timers on disconnect", () => {
  vi.useFakeTimers({ now });
  const timers = watchRetentionTimers();
  state.completed = true;
  const { registry, union } = setup();
  registry.set(config, {
    environment: { environmentId: env, capabilities },
  } as unknown as ServerConfig);
  registry.get(union);
  expect(timers.count()).toBe(2);
  registry.set(
    bots,
    AsyncResult.success({
      bots: [
        { botId: BotId.make("member"), role: "member", state: "deleted" },
        { botId: BotId.make("deleted"), role: "member", state: "deleted" },
      ],
    }),
  );
  registry.get(union);
  vi.advanceTimersByTime(0);
  expect(timers.count()).toBe(1);
  registry.set(
    connection,
    AsyncResult.success([{ phase: "disconnected" }, Option.none()] as never),
  );
  registry.get(union);
  vi.advanceTimersByTime(0);
  expect(timers.count()).toBe(0);
  registry.dispose();
  timers.restore();
  vi.useRealTimers();
});

const failedListSetup = () => {
  state.completed = false;
  state.byBot = {};
  state.failing = {};
  const registry = AtomRegistry.make();
  const atoms = createChannelEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"])),
  );
  registry.set(config, {
    environment: { environmentId: env, capabilities },
  } as unknown as ServerConfig);
  registry.set(connection, AsyncResult.success([{ phase: "connected" }, Option.some({})] as never));
  registry.set(
    bots,
    AsyncResult.success({
      bots: [{ botId: BotId.make("member"), role: "member", state: "active" }],
    }) as never,
  );
  const listed = atoms.listedBotWork({
    environmentIdsAtom: Atom.make([env]),
    signal: () => Atom.make(""),
  });
  return { registry, atoms, listed };
};
const listedThreads = (
  registry: AtomRegistry.AtomRegistry,
  listed: Atom.Atom<ReadonlyArray<{ threadId: string }>>,
) =>
  registry
    .get(listed)
    .map((ref) => ref.threadId)
    .toSorted();

it("a failed bot list re-reads itself and its work is hidden again, without any other bot's timer", () => {
  vi.useFakeTimers({ now });
  const { registry, listed } = failedListSetup();
  state.failing = { main: true };
  const stop = registry.mount(listed);
  expect(listedThreads(registry, listed)).toEqual(["member"]);
  const memberReads = state.byBot.member;
  state.failing = {};
  vi.advanceTimersByTime(60_000);
  expect(listedThreads(registry, listed)).toEqual(["main", "member"]);
  expect(state.byBot.member).toBe(memberReads);
  stop();
  registry.dispose();
  vi.useRealTimers();
});

it("a bot list that keeps failing stops re-reading after the retry window", () => {
  vi.useFakeTimers({ now });
  const { registry, listed } = failedListSetup();
  state.failing = { main: true };
  const stop = registry.mount(listed);
  registry.get(listed);
  const first = state.byBot.main ?? 0;
  vi.advanceTimersByTime(20 * 60_000);
  registry.get(listed);
  const retries = (state.byBot.main ?? 0) - first;
  expect(retries).toBe(10);
  vi.advanceTimersByTime(60 * 60_000);
  registry.get(listed);
  expect((state.byBot.main ?? 0) - first).toBe(retries);
  stop();
  registry.dispose();
  vi.useRealTimers();
});

it("a failed governed list hides nothing and recovers the same way", () => {
  vi.useFakeTimers({ now });
  const { registry, atoms } = failedListSetup();
  state.failing = { main: true };
  const perBot = atoms.homeCurrentOpenableWorkAtom([env, BotId.make("main")]);
  const stop = registry.mount(perBot);
  expect(registry.get(perBot)).toMatchObject({ list: "failed", links: [] });
  state.failing = {};
  vi.advanceTimersByTime(60_000);
  expect(registry.get(perBot).list).toBe("ready");
  expect(registry.get(perBot).links.map((link) => link.threadId)).toEqual(["main"]);
  stop();
  registry.dispose();
  vi.useRealTimers();
});

it("a failed list on a disconnected environment arms no retry", () => {
  vi.useFakeTimers({ now });
  const timers = watchRetentionTimers();
  const { registry, listed } = failedListSetup();
  registry.set(
    connection,
    AsyncResult.success([{ phase: "disconnected" }, Option.none()] as never),
  );
  state.failing = { main: true };
  const stop = registry.mount(listed);
  registry.get(listed);
  expect(timers.count()).toBe(0);
  stop();
  registry.dispose();
  timers.restore();
  vi.useRealTimers();
});

it("the last unsubscribe clears the timer without disposing the registry", () => {
  vi.useFakeTimers({ now });
  const timers = watchRetentionTimers();
  const { registry, atoms, listed } = failedListSetup();
  state.completed = true;
  registry.set(bots, AsyncResult.success({ bots: [] }) as never);
  const union = atoms.homeCurrentOpenableWorkByEnvironment(env);
  const perBot = atoms.homeCurrentOpenableWorkAtom([env, BotId.make("main")]);
  const stops = [registry.mount(perBot), registry.mount(union), registry.mount(listed)];
  registry.get(perBot);
  registry.get(union);
  registry.get(listed);
  expect(timers.count()).toBe(1);
  for (const stop of stops) stop();
  vi.advanceTimersByTime(0);
  expect(timers.count()).toBe(0);
  const reads = state.reads;
  vi.advanceTimersByTime(3_600_000);
  expect(state.reads).toBe(reads);
  registry.dispose();
  timers.restore();
  vi.useRealTimers();
});
