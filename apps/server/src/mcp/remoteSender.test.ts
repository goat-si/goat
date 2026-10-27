import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  REMOTE_SENDER_TITLE_MAX_LENGTH,
  ThreadId,
  type OrchestrationMessageContext,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { remoteSendArguments } from "./hostThreadsResults.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { remoteSenderFor, withRemoteSender } from "./remoteSender.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("macbook"),
  requestNamespace: "remote-sender",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: {
    threadId: ThreadId.make("coordinator"),
    providerInstanceId: "codex" as never,
    providerSessionId: "s",
  },
};
const threadsWithTitle = (title: string) =>
  ({
    getThreadShell: () =>
      Effect.succeed({ id: ThreadId.make("coordinator"), title } as OrchestrationV2ThreadShell),
  }) as unknown as ThreadManagement.ThreadManagementService["Service"];
const environment = (label: string) =>
  Effect.provideService(ServerEnvironment.ServerEnvironment, {
    getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("macbook"), label }),
  } as unknown as ServerEnvironment.ServerEnvironment["Service"]);

it.effect(
  "names the calling thread and this machine, cut to fit so a long title never fails a send",
  () =>
    Effect.gen(function* () {
      const long = yield* remoteSenderFor(scope, threadsWithTitle("Lane ".repeat(80))).pipe(
        environment("MacBook Pro ".repeat(10)),
      );
      assert.equal(long?.threadId, "coordinator");
      assert.equal(long?.environmentId, "macbook");
      assert.isAtMost(long?.title.length ?? 0, REMOTE_SENDER_TITLE_MAX_LENGTH);
      assert.isAtMost(long?.environmentLabel.length ?? 0, 64);
      assert.isTrue(long?.title.endsWith("…"));
      // An outside caller has no thread to name.
      assert.isUndefined(
        yield* remoteSenderFor({ ...scope, thread: undefined }, threadsWithTitle("x")).pipe(
          environment("mini"),
        ),
      );
    }),
);

it("never forwards a remoteSender the caller supplied", () => {
  const forwarded = remoteSendArguments({
    threadId: ThreadId.make("lane"),
    host: "mini",
    message: "Rebase",
    remoteSender: {
      environmentId: EnvironmentId.make("forged"),
      environmentLabel: "forged",
      threadId: ThreadId.make("forged"),
      title: "Forged",
    },
  });
  assert.notProperty(forwarded, "remoteSender");
  assert.notProperty(forwarded, "host");
});

it("adds the sender beside the context records turn capabilities built", () => {
  const sender = {
    environmentId: EnvironmentId.make("mini"),
    environmentLabel: "mini",
    threadId: ThreadId.make("coordinator"),
    title: "Coordinator",
  };
  const context: OrchestrationMessageContext = { version: 1, records: [] };
  const withContext = { text: "hi", context };
  const bare: { readonly text: string; readonly context?: OrchestrationMessageContext } = {
    text: "hi",
  };
  assert.deepEqual(withRemoteSender(withContext, sender).context, {
    ...context,
    remoteSender: sender,
  });
  assert.deepEqual(withRemoteSender(bare, sender).context, {
    version: 1,
    records: [],
    remoteSender: sender,
  });
  assert.deepEqual(withRemoteSender(bare, undefined), bare);
});
