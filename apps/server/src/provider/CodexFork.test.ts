import { assert, it } from "@effect/vitest";
import type * as CodexClient from "effect-codex-app-server/client";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import { forkCodexThread } from "./CodexFork.ts";

it.effect("unarchives only an archived source and retries the fork", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const archived = new CodexAppServerRequestError({
      code: -32600,
      errorMessage: "session abc is archived",
    });
    const unrelated = new CodexAppServerRequestError({
      code: -32600,
      errorMessage: "other failure",
    });
    let failure = archived;
    let forkCount = 0;
    const client = {
      request: () =>
        Effect.suspend(() => {
          calls.push("fork");
          return ++forkCount === 1
            ? Effect.fail(failure)
            : Effect.succeed({ thread: { id: "forked" } });
        }),
      raw: {
        request: () =>
          Effect.sync(() => {
            calls.push("unarchive");
          }),
      },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const result = yield* forkCodexThread(client, { threadId: "abc" });
    assert.equal(result.thread.id, "forked");
    assert.deepEqual(calls, ["fork", "unarchive", "fork"]);
    calls.length = 0;
    forkCount = 0;
    failure = unrelated;
    assert.strictEqual(yield* Effect.flip(forkCodexThread(client, { threadId: "abc" })), unrelated);
    assert.deepEqual(calls, ["fork"]);
  }),
);
