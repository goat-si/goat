import {
  BotThreadRow,
  EnvironmentId,
  ThreadId,
  type ChannelListBotThreadsResult,
  type ServerConfig,
} from "@goat/contracts";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-11-04T12:00:00.000Z");
const environmentId = EnvironmentId.make("bot-home");
const worker = { environmentId, threadId: ThreadId.make("channel-worker:task") };

// The server's answer, read each time a bot-thread list is fetched.
const server = vi.hoisted(() => ({
  answer: (): ChannelListBotThreadsResult => ({ rows: [], mainMessageCount: 0 }),
}));
const config = Atom.make<ServerConfig | null>({
  environment: { environmentId: "bot-home", capabilities: { goatBotTaskThreads: true } },
} as unknown as ServerConfig);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => config }),
}));
vi.mock("./runtime.ts", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  return {
    createEnvironmentRpcCommand: (_runtime: unknown, options: unknown) => ({ options }),
    createEnvironmentRpcSubscriptionAtomFamily: () => () => A.make(null),
    createEnvironmentRpcQueryAtomFamily: (
      _runtime: unknown,
      options: {
        readonly tag: string;
        readonly refreshTrigger?: (target: unknown) => Atom.Atom<unknown> | undefined;
      },
    ) => {
      const family = A.family((key: string) => {
        const target = JSON.parse(key) as unknown;
        const trigger = options.refreshTrigger?.(target);
        return A.make((get) => {
          if (trigger !== undefined) get(trigger);
          return options.tag === "channel.listBotThreads"
            ? R.success(server.answer())
            : R.success({ bots: [], groups: [] });
        });
      });
      return (target: unknown) => family(JSON.stringify(target));
    },
  };
});

const decodeRow = Schema.decodeSync(BotThreadRow);
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const taskRow = (options: {
  readonly completedAt: number;
  readonly doneAt?: number;
  readonly pinnedAt?: number;
}) =>
  decodeRow({
    kind: "task",
    task: {
      taskId: "task",
      title: "Tidy the release notes",
      status: "completed",
      updatedAt: iso(options.completedAt),
      completedAt: iso(options.completedAt),
    },
    view: {
      taskId: "task",
      pinnedAt: options.pinnedAt === undefined ? null : iso(options.pinnedAt),
      doneAt: options.doneAt === undefined ? null : iso(options.doneAt),
      readThrough: null,
    },
    lastActivityAt: iso(options.completedAt),
    unread: false,
    mainMessagesSinceQuiet: 0,
    worker,
  });

const setup = () => {
  const registry = AtomRegistry.make();
  const atoms = createChannelEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"])),
  );
  const listed = atoms.listedBotWork({
    environmentIdsAtom: Atom.make([environmentId]),
    signal: () => Atom.make("unchanged"),
  });
  registry.mount(listed);
  return { registry, atoms, listed: () => registry.get(listed) };
};

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

it.effect("lists an expired task's worker no more once unpinning it succeeds", () =>
  Effect.gen(function* () {
    const pinned = taskRow({ completedAt: START - 96 * HOUR, pinnedAt: START - 90 * HOUR });
    server.answer = () => ({ rows: [pinned], mainMessageCount: 0 });
    const { registry, atoms, listed } = setup();
    expect(listed()).toEqual([worker]);

    // The server leaves an unpinned task out once it finished more than three days ago.
    server.answer = () => ({ rows: [], mainMessageCount: 0 });
    const command = atoms.updateTaskView as unknown as {
      readonly options: {
        readonly onSuccess?: (
          target: { readonly environmentId: EnvironmentId },
          registry: AtomRegistry.AtomRegistry,
        ) => Effect.Effect<void>;
      };
    };
    yield* command.options.onSuccess?.({ environmentId }, registry) ?? Effect.void;
    expect(listed()).toEqual([]);
    registry.dispose();
  }),
);

it("follows the bot UI's own list when it re-reads the rows", () => {
  server.answer = () => ({ rows: [taskRow({ completedAt: START - HOUR })], mainMessageCount: 0 });
  const { registry, atoms, listed } = setup();
  expect(listed()).toEqual([worker]);

  server.answer = () => ({ rows: [], mainMessageCount: 0 });
  registry.refresh(atoms.listBotThreads({ environmentId, input: {} }));
  expect(listed()).toEqual([]);
  registry.dispose();
});

it("stops listing a done task when the bot UI ages it out after three days", () => {
  server.answer = () => ({
    rows: [taskRow({ completedAt: START - 80 * HOUR, doneAt: START - 71 * HOUR })],
    mainMessageCount: 0,
  });
  const { registry, listed } = setup();
  expect(listed()).toEqual([worker]);

  vi.advanceTimersByTime(HOUR);
  expect(listed()).toEqual([]);
  registry.dispose();
});

it("re-reads the rows when the server's three-day cutoff passes a finished task", () => {
  const completedAt = START - 71 * HOUR;
  // The server's own clock decides the cutoff; the fake timers move it.
  server.answer = () => ({
    rows:
      (vi.getMockedSystemTime()?.valueOf() ?? START) < completedAt + 72 * HOUR
        ? [taskRow({ completedAt })]
        : [],
    mainMessageCount: 0,
  });
  const { registry, listed } = setup();
  expect(listed()).toEqual([worker]);

  vi.advanceTimersByTime(HOUR + 1_000);
  expect(listed()).toEqual([]);
  registry.dispose();
});

it("keeps re-reading when the server still lists a task at or just past its cutoff", () => {
  const completedAt = START - 71 * HOUR;
  const cutoff = completedAt + 72 * HOUR;
  // The server keeps the task at its cutoff and its clock trails ours by thirty seconds.
  server.answer = () => ({
    rows:
      (vi.getMockedSystemTime()?.valueOf() ?? START) - 30_000 <= cutoff
        ? [taskRow({ completedAt })]
        : [],
    mainMessageCount: 0,
  });
  const { registry, listed } = setup();
  expect(listed()).toEqual([worker]);

  vi.advanceTimersByTime(HOUR + 1_000);
  expect(listed()).toEqual([worker]);
  vi.advanceTimersByTime(60_000);
  expect(listed()).toEqual([]);
  registry.dispose();
});

it("re-reads the bot list while a remote launch waits for its destination, whatever the server clock says", () => {
  let reads = 0;
  const pending = {
    childWorkId: "child-work:remote",
    taskId: "task",
    callerThreadId: "goat-bot-session:main",
    host: "macbookair",
    state: "launched",
    // The server clock trails this client by five minutes.
    lastActivityAt: iso(START - 5 * 60_000),
  };
  server.answer = () => {
    reads += 1;
    return {
      rows: [],
      mainMessageCount: 0,
      remoteWork: [pending],
    } as unknown as ChannelListBotThreadsResult;
  };
  const { registry, listed } = setup();
  listed();
  const first = reads;

  vi.advanceTimersByTime(5_000);
  listed();
  expect(reads).toBeGreaterThan(first);

  // Past the bounded window the list is no longer re-read on its own.
  vi.advanceTimersByTime(3 * 60_000);
  listed();
  const settled = reads;
  vi.advanceTimersByTime(60_000);
  listed();
  expect(reads).toBe(settled);
  registry.dispose();
});
