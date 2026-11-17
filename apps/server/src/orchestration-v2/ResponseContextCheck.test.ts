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
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { builtInSkillProviderText } from "./BuiltInSkillText.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const here = EnvironmentId.make("env-1");
const main = ThreadId.make("main");
const side = ThreadId.make("side");
const other = ThreadId.make("other");

const items = new Map<string, Partial<OrchestrationV2TurnItem>>([
  ["main/item-1", { type: "assistant_message", messageId: MessageId.make("m1") }],
  ["main/item-user", { type: "user_message", messageId: MessageId.make("m2") }],
  ["other/item-9", { type: "assistant_message", messageId: MessageId.make("m9") }],
]);

const store = Layer.mock(ProjectionStoreV2)({
  getThread: (threadId) =>
    Effect.succeed({
      id: threadId,
      sideChatOf: threadId === side ? main : null,
      forkedFrom: null,
    } as never),
  getTurnItem: ({ threadId, itemId }) =>
    Effect.succeed((items.get(`${threadId}/${itemId}`) ?? null) as OrchestrationV2TurnItem | null),
  getThreadRecords: (threadId) =>
    Effect.succeed({
      subagents:
        threadId === main
          ? [{ childThreadId: ThreadId.make("review-search") }, { childThreadId: null }]
          : [],
    } as never),
});
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

const providerText = (record: ComposerContextRecord, threadId: ThreadId | undefined = main) =>
  builtInSkillProviderText(Option.none(), {
    message: {
      ...(threadId === undefined ? {} : { threadId }),
      text: "[Reviewer finished](goat-context://v1/response/response_m1) check the empty state too",
      context: { records: [record] },
    },
    driver: "codex",
    project: Effect.succeed(null),
  }).pipe(Effect.provide(Layer.mergeAll(store, identity)));

const UNAVAILABLE = '<context kind="response" id="response_m1" unavailable="true"/>';

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
      const text = yield* providerText(reply(), undefined);
      expect(text).toContain(UNAVAILABLE);
      expect(text).not.toContain("thread.read");
    }),
  );
});
