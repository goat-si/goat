import {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  EnvironmentId,
  type ChannelListBotThreadsResult,
  type ServerConfig,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { homeWorkGoverns } from "../goatBot/homeCurrentOpenableWork.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

const decodeRemote = Schema.decodeUnknownSync(BotRemoteWork);
const env = EnvironmentId.make("source");
// Home lists a bot's work with goatBotTaskThreads; the newer two add history and lookup.
const TASK_CAPABILITIES = {
  goatBotTaskThreads: true,
  goatBotTaskThreadsPaged: true,
  goatBotTaskLookupSearch: true,
};
const config = Atom.make<ServerConfig | null>({
  environment: {
    environmentId: env,
    capabilities: TASK_CAPABILITIES,
  },
} as unknown as ServerConfig);
const destination = EnvironmentId.make("destination");
const destinationConfig = Atom.make<ServerConfig | null>({
  environment: { environmentId: destination },
} as unknown as ServerConfig);
const connection = Atom.make(
  AsyncResult.success([{ phase: "connected" }, Option.some({})] as const),
);
const permission = Atom.make(true);
const row = Schema.decodeSync(BotThreadRow)({
  kind: "task",
  task: { taskId: "a", title: "Task", status: "running", updatedAt: "2026-11-04T00:00:00.000Z" },
  view: { taskId: "a", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: "2026-11-04T00:00:00.000Z",
  unread: false,
  mainMessagesSinceQuiet: 0,
  worker: { environmentId: "source", threadId: "worker" },
});
const answer = { rows: [row], mainMessageCount: 0 };
const query = Atom.make<AsyncResult.AsyncResult<ChannelListBotThreadsResult, Error>>(
  AsyncResult.success(answer),
);
const reads = vi.hoisted(() => ({ list: 0 }));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    initialConfigValueAtom: (id: EnvironmentId) => (id === env ? config : destinationConfig),
  }),
}));
vi.mock("./environmentConnections.ts", () => ({
  environmentConnectionAtoms: () => () => connection,
}));
vi.mock("./commandPermissions.ts", () => ({
  createCommandPermissions: () => ({ permissionAtom: () => permission }),
}));
vi.mock("./runtime.ts", async () => {
  const { Atom: A } = await import("effect/reactivity");
  return {
    createEnvironmentRpcCommand: () => ({}),
    // Every evaluation of the list query counts as one list read.
    createEnvironmentRpcQueryAtomFamily: () => {
      const counted = A.make((get) => {
        reads.list++;
        return get(query);
      });
      return () => counted;
    },
    createEnvironmentRpcSubscriptionAtomFamily: () => () => A.make(null),
    createEnvironmentSubscriptionAtomFamily: () => () => A.make(null),
  };
});

it("keeps links during refresh, restores Threads on failure, and recovers", () => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  const atom = createChannelEnvironmentAtoms(runtime).homeCurrentOpenableWorkAtom([
    env,
    BotId.make("main"),
  ]);
  registry.mount(atom);
  expect(registry.get(atom).links).toHaveLength(1);
  expect(registry.get(atom).list).toBe("ready");
  expect(registry.get(atom).work.running).toHaveLength(1);
  registry.set(query, AsyncResult.success(answer, { waiting: true }));
  expect(registry.get(atom).links).toHaveLength(1);
  expect(registry.get(atom).list).toBe("ready");
  registry.set(
    query,
    AsyncResult.fail(new Error("offline"), {
      previousSuccess: Option.some(AsyncResult.success(answer)),
    }),
  );
  expect(registry.get(atom).links).toHaveLength(0);
  expect(registry.get(atom).list).toBe("failed");
  expect(registry.get(atom).work.running).toHaveLength(0);
  registry.set(query, AsyncResult.success(answer));
  expect(registry.get(atom).links).toHaveLength(1);
  expect(registry.get(atom).list).toBe("ready");
  registry.dispose();
});

it("tracks capability, source, destination, and current-link transitions without stale hides", () => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  const atom = createChannelEnvironmentAtoms(runtime).homeCurrentOpenableWorkAtom([
    env,
    BotId.make("main"),
  ]);
  const item = decodeRemote({
    childWorkId: "remote",
    taskId: "a",
    callerThreadId: "caller",
    host: "host",
    state: "bound",
    lastActivityAt: "2026-11-04T00:00:00.000Z",
    environmentId: destination,
    threadId: "remote-thread",
  });
  const both = { ...answer, remoteWork: [item] };
  registry.set(query, AsyncResult.success(both));
  registry.mount(atom);
  const links = () => registry.get(atom).links.map((entry) => entry.threadId);
  expect(links()).toEqual(["worker", "remote-thread"]);
  registry.set(destinationConfig, null);
  expect(links()).toEqual(["worker"]);
  registry.set(destinationConfig, {
    environment: { environmentId: destination },
  } as unknown as ServerConfig);
  expect(links()).toEqual(["worker", "remote-thread"]);
  registry.set(query, AsyncResult.success({ rows: [], mainMessageCount: 0 }));
  expect(links()).toEqual([]);
  registry.set(query, AsyncResult.success(both));
  expect(links()).toEqual(["worker", "remote-thread"]);
  registry.set(config, {
    environment: {
      environmentId: env,
      capabilities: { goatBotTaskThreadsPaged: false, goatBotTaskLookupSearch: true },
    },
  } as unknown as ServerConfig);
  expect(registry.get(atom).eligible).toBe(false);
  expect(links()).toEqual([]);
  registry.set(config, {
    environment: {
      environmentId: env,
      capabilities: TASK_CAPABILITIES,
    },
  } as unknown as ServerConfig);
  expect(links()).toEqual(["worker", "remote-thread"]);
  registry.set(
    connection,
    AsyncResult.success([{ phase: "disconnected" }, Option.none()] as never),
  );
  expect(registry.get(atom).eligible).toBe(false);
  expect(links()).toEqual([]);
  registry.set(connection, AsyncResult.success([{ phase: "connected" }, Option.some({})] as const));
  expect(links()).toEqual(["worker", "remote-thread"]);
  registry.set(query, AsyncResult.initial());
  expect(registry.get(atom).list).toBe("pending");
  expect(links()).toEqual([]);
  registry.dispose();
});

const decodeRow = Schema.decodeSync(BotThreadRow);
const unreadRow = (unread: boolean, workerThread = "worker") =>
  decodeRow({
    kind: "task",
    task: { taskId: "a", title: "Task", status: "running", updatedAt: "2026-11-04T00:00:00.000Z" },
    view: { taskId: "a", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T00:00:00.000Z",
    unread,
    mainMessagesSinceQuiet: 0,
    worker: { environmentId: "source", threadId: workerThread },
  });

it("derives a bot's unread count once per work value and tells its subscriber only when it changes", () => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  registry.set(config, {
    environment: {
      environmentId: env,
      capabilities: TASK_CAPABILITIES,
    },
  } as unknown as ServerConfig);
  registry.set(query, AsyncResult.success({ rows: [unreadRow(true)], mainMessageCount: 0 }));
  const unread = createChannelEnvironmentAtoms(runtime).homeCurrentUnreadAtom([
    env,
    BotId.make("main"),
  ]);
  const seen: unknown[] = [];
  registry.subscribe(unread, (value) => seen.push(value), { immediate: true });
  expect(seen).toEqual([1]);
  // The worker moves: links change, the count does not, so the row hears nothing.
  registry.set(
    query,
    AsyncResult.success({ rows: [unreadRow(true, "moved")], mainMessageCount: 0 }),
  );
  expect(registry.get(unread)).toBe(1);
  expect(seen).toEqual([1]);
  registry.set(query, AsyncResult.success({ rows: [unreadRow(false)], mainMessageCount: 0 }));
  expect(seen).toEqual([1, 0]);
  registry.set(query, AsyncResult.fail(new Error("offline")));
  expect(seen).toEqual([1, 0, "unavailable"]);
  registry.dispose();
});

it("an ineligible bot's Home work reads no list", () => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  registry.set(config, {
    environment: { environmentId: env, capabilities: { goatBotTaskThreads: true } },
  } as unknown as ServerConfig);
  const atom = createChannelEnvironmentAtoms(runtime).homeCurrentOpenableWorkAtom([
    env,
    BotId.make("main"),
  ]);
  reads.list = 0;
  registry.mount(atom);
  expect(registry.get(atom)).toMatchObject({ eligible: false, links: [] });
  expect(reads.list).toBe(0);
  registry.dispose();
});

it("governs only with all three task capabilities: without goatBotTaskThreads Home reads no list and Threads keeps the legacy rule", () => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  registry.set(config, {
    environment: {
      environmentId: env,
      capabilities: { goatBotTaskThreadsPaged: true, goatBotTaskLookupSearch: true },
    },
  } as unknown as ServerConfig);
  registry.set(query, AsyncResult.success(answer));
  const union = createChannelEnvironmentAtoms(runtime).homeCurrentOpenableWorkByEnvironment(env);
  reads.list = 0;
  registry.mount(union);
  expect(registry.get(union).byBot).toEqual([{ botId: "main", eligible: false, list: "pending" }]);
  expect(registry.get(union).links).toEqual([]);
  expect(homeWorkGoverns(registry.get(union))).toBe(false);
  expect(reads.list).toBe(0);
  registry.set(config, {
    environment: { environmentId: env, capabilities: TASK_CAPABILITIES },
  } as unknown as ServerConfig);
  expect(homeWorkGoverns(registry.get(union))).toBe(true);
  expect(registry.get(union).links.map((link) => link.threadId)).toEqual(["worker"]);
  registry.dispose();
});
