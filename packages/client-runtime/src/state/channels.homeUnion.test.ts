import { BotId, BotThreadRow, EnvironmentId, type ServerConfig } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
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
