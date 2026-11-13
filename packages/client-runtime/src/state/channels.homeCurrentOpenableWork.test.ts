import {
  BotId,
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
import { createChannelEnvironmentAtoms } from "./channels.ts";

const env = EnvironmentId.make("source");
const config = Atom.make({
  environment: {
    environmentId: env,
    capabilities: { goatBotTaskThreadsPaged: true, goatBotTaskLookupSearch: true },
  },
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
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => config }),
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
    createEnvironmentRpcQueryAtomFamily: () => () => query,
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
