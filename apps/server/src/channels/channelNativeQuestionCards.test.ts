import { assert, it } from "@effect/vitest";
import { RuntimeRequestId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { approvalRequestDetail } from "./channelNativeQuestionCards.ts";

const requestId = RuntimeRequestId.make("approval:deploy");
const threadId = ThreadId.make("thread:deploy");

/** A local thread that holds a pending command approval with this exact id. */
const localThreads = {
  getThreadRecords: () =>
    Effect.succeed({
      runs: [],
      runtimeRequests: [{ id: requestId, kind: "command", status: "pending" }],
      turnItems: [{ type: "approval_request", requestId, prompt: "rm -rf build/" }],
    }),
} as unknown as ThreadManagement.ThreadManagementService["Service"];

it.effect("a remote approval never borrows a local thread's details for the same ids", () =>
  Effect.gen(function* () {
    const local = yield* approvalRequestDetail({ requestId, threadId }, localThreads);
    assert.strictEqual(local.prompt, "rm -rf build/");
    const remote = yield* approvalRequestDetail(
      { requestId, threadId, host: "mini" },
      localThreads,
    );
    assert.deepStrictEqual(remote, { kind: undefined, prompt: undefined });
  }),
);
