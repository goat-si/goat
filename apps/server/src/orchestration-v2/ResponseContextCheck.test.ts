import {
  type ComposerContextId,
  type ComposerContextRecord,
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { builtInSkillProviderText } from "./BuiltInSkillText.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const here = EnvironmentId.make("env-1");
const main = ThreadId.make("main");
const side = ThreadId.make("side");
const other = ThreadId.make("other");
const fork = ThreadId.make("fork");
const forkOfFork = ThreadId.make("fork-of-fork");
const sideOfFork = ThreadId.make("side-of-fork");
const loopA = ThreadId.make("loop-a");
const loopB = ThreadId.make("loop-b");
const deletedFork = ThreadId.make("deleted-fork");
const belowDeleted = ThreadId.make("below-deleted");
const archivedFork = ThreadId.make("archived-fork");
const belowArchived = ThreadId.make("below-archived");
const otherProject = ThreadId.make("other-project");
const belowOtherProject = ThreadId.make("below-other-project");
const sibling = ThreadId.make("sibling");
const child = ThreadId.make("child");
const orphan = ThreadId.make("orphan");
const missing = ThreadId.make("missing");
const chain = Array.from({ length: 41 }, (_, index) => ThreadId.make(`chain-${index}`));

// Side chats and run forks both show their source's history as inherited rows.
const runFork = (threadId: ThreadId) => ({ type: "run", threadId, runId: "run-1" });
const threads = new Map<
  ThreadId,
  {
    sideChatOf: ThreadId | null;
    forkedFrom: unknown;
    deletedAt?: string;
    archivedAt?: string;
    projectId?: string;
  }
>([
  [side, { sideChatOf: main, forkedFrom: runFork(main) }],
  [fork, { sideChatOf: null, forkedFrom: runFork(main) }],
  [forkOfFork, { sideChatOf: null, forkedFrom: runFork(fork) }],
  [sideOfFork, { sideChatOf: fork, forkedFrom: runFork(fork) }],
  [loopA, { sideChatOf: null, forkedFrom: runFork(loopB) }],
  [loopB, { sideChatOf: null, forkedFrom: runFork(loopA) }],
  [deletedFork, { sideChatOf: null, forkedFrom: runFork(main), deletedAt: "2026-11-17T00:00:00Z" }],
  [belowDeleted, { sideChatOf: null, forkedFrom: runFork(deletedFork) }],
  [
    archivedFork,
    { sideChatOf: null, forkedFrom: runFork(main), archivedAt: "2026-11-17T00:00:00Z" },
  ],
  [belowArchived, { sideChatOf: null, forkedFrom: runFork(archivedFork) }],
  [otherProject, { sideChatOf: null, forkedFrom: null, projectId: "project-2" }],
  [belowOtherProject, { sideChatOf: null, forkedFrom: runFork(otherProject) }],
  [sibling, { sideChatOf: null, forkedFrom: runFork(main) }],
  [child, { sideChatOf: null, forkedFrom: runFork(fork) }],
  [orphan, { sideChatOf: null, forkedFrom: runFork(missing) }],
  ...chain.map(
    (threadId, index) =>
      [threadId, { sideChatOf: null, forkedFrom: runFork(chain[index - 1] ?? main) }] as const,
  ),
]);

const items = new Map<string, Partial<OrchestrationV2TurnItem>>([
  ["main/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["main/item-user", { type: "user_message", messageId: MessageId.make("m2") }],
  ["other/item-9", { type: "assistant_message", messageId: MessageId.make("m9") }],
  ["deleted-fork/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["archived-fork/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["other-project/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["sibling/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["child/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["orphan/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
]);

// Each read is recorded in `reads`, for the case that counts them.
const makeStore = (reads: Array<ThreadId> = []) =>
  Layer.mock(ProjectionStoreV2)({
    getThread: (threadId) => {
      reads.push(threadId);
      return threadId === missing
        ? Effect.fail(new Error("no such thread") as never)
        : Effect.succeed({
            id: threadId,
            deletedAt: null,
            archivedAt: null,
            ...(threads.get(threadId) ?? { sideChatOf: null, forkedFrom: null }),
          } as never);
    },
    getTurnItem: ({ threadId, itemId }) =>
      Effect.succeed(
        (items.get(`${threadId}/${itemId}`) ?? null) as OrchestrationV2TurnItem | null,
      ),
    getThreadRecords: (threadId) =>
      Effect.succeed({
        subagents:
          threadId === main
            ? [{ childThreadId: ThreadId.make("review-search") }, { childThreadId: null }]
            : [],
      } as never),
  });
const store = makeStore();
const identity = Layer.succeed(ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(here),
});

const reply = (
  overrides: {
    readonly environmentId?: EnvironmentId;
    readonly threadId?: ThreadId;
    readonly messageId?: MessageId;
    readonly itemId?: string;
    readonly subagents?: ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly title: string;
      readonly environmentId?: EnvironmentId;
    }>;
  } = {},
): ComposerContextRecord => ({
  version: 1,
  kind: "response",
  contextId: "response_m1" as ComposerContextId,
  label: "Reviewer finished",
  citation: {
    version: 1,
    environmentId: overrides.environmentId ?? here,
    threadId: overrides.threadId ?? main,
    messageId: overrides.messageId ?? MessageId.make("m1"),
    text: "Reviewer finished and returned blocked.",
    start: 0,
    end: 39,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make(overrides.itemId ?? "item-1"),
  ...(overrides.subagents ? { subagents: overrides.subagents } : {}),
});

// null is a message without a thread; undefined would take the default.
const providerText = (record: ComposerContextRecord, threadId: ThreadId | null = main) =>
  builtInSkillProviderText(Option.none(), {
    message: {
      ...(threadId === null ? {} : { threadId }),
      text: "[Reviewer finished](goat-context://v1/response/response_m1) check the empty state too",
      context: { records: [record] },
    },
    driver: "codex",
    project: Effect.succeed(null),
  }).pipe(Effect.provide(Layer.mergeAll(store, identity)));

const UNAVAILABLE = '<context kind="response" id="response_m1" unavailable="true"/>';

const providerTextWith = (layer: Layer.Layer<never>) =>
  builtInSkillProviderText(Option.none(), {
    message: {
      threadId: main,
      text: "[Reviewer finished](goat-context://v1/response/response_m1) check the empty state too",
      context: { records: [reply()] },
    },
    driver: "codex",
    project: Effect.succeed(null),
  }).pipe(Effect.provide(layer));

const capturedLogs = () => {
  const logs: Array<string> = [];
  const layer = Logger.layer(
    [Logger.make(({ message }) => void logs.push(JSON.stringify(message)))],
    { mergeWithExisting: false },
  );
  return { logs, layer };
};

describe("a reply to a response, checked by the server before an agent reads it", () => {
  it.effect("tells the agent to read an assistant message of the receiving thread", () =>
    Effect.gen(function* () {
      const text = yield* providerText(
        reply({
          subagents: [
            { threadId: ThreadId.make("review-search"), title: "review (search)" },
            { threadId: ThreadId.make("not-a-child"), title: "someone else's" },
            { threadId: ThreadId.make("review-search"), title: "remote", environmentId: here },
          ],
        }),
      );
      expect(text).toContain(
        'goat_call {path:"thread.read", args:{threadId: "main", itemId: "item-1"}}',
      );
      expect(text).toContain("about subagent: review (search)\nsubagent threadId: review-search");
      expect(text).not.toContain("not-a-child");
      expect(text).not.toContain("about subagent: remote");
    }),
  );

  it.effect("reads a side chat's reply to its parent's response from the parent thread", () =>
    Effect.gen(function* () {
      const text = yield* providerText(reply(), side);
      expect(text).toContain('args:{threadId: "main", itemId: "item-1"}');
    }),
  );

  it.effect("reads a reply to a response two forks up from the thread that holds it", () =>
    Effect.gen(function* () {
      for (const receiving of [forkOfFork, sideOfFork]) {
        const text = yield* providerText(reply(), receiving);
        expect(text).toContain('args:{threadId: "main", itemId: "item-1"}');
      }
    }),
  );

  it.effect(
    "leaves a reply unavailable when it names the receiving thread for an item it only inherits",
    () =>
      Effect.gen(function* () {
        const text = yield* providerText(reply({ threadId: side }), side);
        expect(text).toContain(UNAVAILABLE);
        expect(text).not.toContain("thread.read");
      }),
  );

  it.effect("stops at a fork loop and leaves a reply to a thread outside it unavailable", () =>
    Effect.gen(function* () {
      const text = yield* providerText(reply(), loopA);
      expect(text).toContain(UNAVAILABLE);
      expect(text).not.toContain("thread.read");
    }),
  );

  it.effect(
    "reads each thread of a long fork chain once, up to the thread that holds the response",
    () =>
      Effect.gen(function* () {
        const reads: Array<ThreadId> = [];
        const text = yield* builtInSkillProviderText(Option.none(), {
          message: {
            threadId: chain.at(-1)!,
            text: "[Reviewer finished](goat-context://v1/response/response_m1) check it",
            context: { records: [reply()] },
          },
          driver: "codex",
          project: Effect.succeed(null),
        }).pipe(Effect.provide(Layer.mergeAll(makeStore(reads), identity)));
        expect(text).toContain('args:{threadId: "main", itemId: "item-1"}');
        expect(reads).toHaveLength(chain.length + 1);
        expect(new Set(reads).size).toBe(reads.length);
      }),
  );

  it.effect(
    "never names a deleted ancestor, but still reads what it inherited from further up",
    () =>
      Effect.gen(function* () {
        const deleted = yield* providerText(reply({ threadId: deletedFork }), belowDeleted);
        expect(deleted).toContain(UNAVAILABLE);
        expect(deleted).not.toContain("thread.read");
        const above = yield* providerText(reply(), belowDeleted);
        expect(above).toContain('args:{threadId: "main", itemId: "item-1"}');
      }),
  );

  it.effect("reads from an archived ancestor and from an ancestor in another project", () =>
    Effect.gen(function* () {
      const archived = yield* providerText(reply({ threadId: archivedFork }), belowArchived);
      expect(archived).toContain('args:{threadId: "archived-fork", itemId: "item-1"}');
      const project = yield* providerText(reply({ threadId: otherProject }), belowOtherProject);
      expect(project).toContain('args:{threadId: "other-project", itemId: "item-1"}');
    }),
  );

  it.effect(
    "never names a sibling, a child or an unknown thread the receiving thread does not descend from",
    () =>
      Effect.gen(function* () {
        for (const [named, receiving] of [
          [sibling, fork],
          [child, fork],
          [missing, orphan],
        ] as const) {
          const text = yield* providerText(reply({ threadId: named }), receiving);
          expect(text).toContain(UNAVAILABLE);
          expect(text).not.toContain("thread.read");
        }
        // An ancestor that cannot be read ends the walk; the thread's own responses still read.
        const own = yield* providerText(reply({ threadId: orphan }), orphan);
        expect(own).toContain('args:{threadId: "orphan", itemId: "item-1"}');
      }),
  );

  it.effect(
    "leaves a reply unavailable when it names another environment, another thread, a missing item, a user message or another message",
    () =>
      Effect.gen(function* () {
        for (const forged of [
          reply({ environmentId: EnvironmentId.make("env-2") }),
          reply({ threadId: other, itemId: "item-9", messageId: MessageId.make("m9") }),
          reply({ itemId: "item-9", messageId: MessageId.make("m9") }),
          reply({ itemId: "item-user", messageId: MessageId.make("m2") }),
          reply({ messageId: MessageId.make("m-other") }),
        ]) {
          const text = yield* providerText(forged);
          expect(text).toContain(UNAVAILABLE);
          expect(text).not.toContain("thread.read");
        }
      }),
  );

  it.effect("leaves a reply unavailable when the message names no thread", () =>
    Effect.gen(function* () {
      const text = yield* providerText(reply(), null);
      expect(text).toContain(UNAVAILABLE);
      expect(text).not.toContain("thread.read");
    }),
  );

  it.effect("warns, naming the missing service and the thread, when it cannot check a reply", () =>
    Effect.gen(function* () {
      for (const [present, missingService] of [
        [store, "ServerEnvironmentIdentity"],
        [identity, "ProjectionStoreV2"],
      ] as const) {
        const captured = capturedLogs();
        const text = yield* providerTextWith(Layer.mergeAll(present, captured.layer));
        expect(text).toContain(UNAVAILABLE);
        expect(captured.logs).toHaveLength(1);
        expect(captured.logs[0]).toContain(missingService);
        expect(captured.logs[0]).toContain('"main"');
        expect(captured.logs[0]).not.toContain("check the empty state");
      }
      const captured = capturedLogs();
      const text = yield* providerTextWith(Layer.mergeAll(store, identity, captured.layer));
      expect(text).toContain("thread.read");
      expect(captured.logs).toEqual([]);
    }),
  );
});
