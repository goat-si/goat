import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { OrchestrationV2ProviderFailure } from "@goat/contracts";
import { watchAntigravityPromptOutcome } from "./AntigravityTurnOutcome.ts";

const failureOf = (
  outcome:
    | OrchestrationV2ProviderFailure
    | { readonly failure: OrchestrationV2ProviderFailure }
    | undefined,
) => (outcome !== undefined && "failure" in outcome ? outcome.failure : outcome);

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const TOOL = 8;
const ERROR_MESSAGE = 17;

// Error-step payloads trimmed from Antigravity 1.4.5 against a local Gemini endpoint.
const errorPayload = (error: string) =>
  Buffer.concat([
    Buffer.from([0x0a, 0x24]),
    Buffer.from(
      `Agent execution terminated due to error.\u0012agent executor error: ${error}: ${error}\n(1) attached stack trace\n  -- stack trace:`,
    ),
  ]);
// An unparsable reset timestamp must not hide the reset delay, nor a retry delay outrank it.
const QUOTA_ERROR = errorPayload(
  "Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s] map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:soon] reason:QUOTA_EXHAUSTED]]",
);
const RATE_LIMIT_ERROR = errorPayload(
  "Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com reason:RATE_LIMIT_EXCEEDED] map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s]]",
);
const INVALID_ARGUMENT_ERROR = errorPayload(
  "Error 400, Message: Request contains an invalid argument., Status: INVALID_ARGUMENT, Details: []",
);
const NOT_FOUND_ERROR = errorPayload(
  "Error 404, Message: Requested entity was not found., Status: NOT_FOUND, Details: []",
);
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message", then the HTTP body.
const STATUS_NOT_FOUND_ERROR = Buffer.concat([
  Buffer.from([0x12, 0x37]),
  Buffer.from(
    'NOT_FOUND (code 404): Requested entity was not found.\u001a\u0080\u0001HTTP 404 Not Found\n\n{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}',
  ),
]);
// Antigravity 1.5 states the quota reset only as a Go duration in its message.
const STATUS_QUOTA_ERROR = Buffer.concat([
  Buffer.from([0x12, 0x6e]),
  Buffer.from(
    "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4m42s.",
  ),
]);
// The model's reply quoting the agent's quota notice is an ordinary planner response.
const QUOTED_NOTICE = Buffer.from(
  "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.",
);

describe("watchAntigravityPromptOutcome", () => {
  it.effect("fails only turns whose own steps end in an upstream error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      let nextIndex = 0;
      const appendSteps = (steps: ReadonlyArray<readonly [number, Uint8Array]>) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
          for (const [type, payload] of steps) insert.run(nextIndex++, type, payload);
        } finally {
          database.close();
        }
      };
      const turn = (
        steps: ReadonlyArray<readonly [number, Uint8Array]>,
        result: EffectAcpSchema.PromptResponse = { stopReason: "end_turn" },
        options?: { readonly retired?: boolean },
      ) =>
        Effect.gen(function* () {
          const check = yield* watchAntigravityPromptOutcome(profileDirectory, sessionId);
          appendSteps(steps);
          return yield* check(result, options);
        });
      const input = Buffer.from("Run the fixture.");
      const reply = Buffer.from("FIXTURE_OK");

      // The first prompt creates the session log.
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, QUOTA_ERROR],
        ]),
        {
          class: "usage_limit",
          message: "You have reached your Antigravity quota for this period.",
          code: "RESOURCE_EXHAUSTED",
          retryable: true,
          resetAt: "1970-01-01T01:00:00.000Z",
        },
      );
      assert.deepInclude(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, STATUS_QUOTA_ERROR],
        ]),
        { class: "usage_limit", resetAt: "1970-01-01T00:04:42.000Z" },
      );
      // The earlier error step is outside this turn.
      assert.isUndefined(
        yield* turn(
          [
            [USER_INPUT, input],
            [PLANNER_RESPONSE, QUOTED_NOTICE],
          ],
          {
            stopReason: "end_turn",
            usage: { inputTokens: 42, outputTokens: 3, totalTokens: 54 },
          },
        ),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, RATE_LIMIT_ERROR],
        ]),
        {
          class: "usage_limit",
          message: "Resource has been exhausted (e.g. check quota).",
          code: "RESOURCE_EXHAUSTED",
          retryable: true,
          resetAt: "1970-01-01T00:00:42.000Z",
        },
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR],
        ]),
        {
          class: "provider_error",
          message: "Request contains an invalid argument.",
          code: "INVALID_ARGUMENT",
          retryable: false,
        },
      );
      // A 404 after the turn already reached the model is a transient edge error, not a bad model.
      for (const error of [NOT_FOUND_ERROR, STATUS_NOT_FOUND_ERROR]) {
        assert.deepEqual(
          yield* turn([
            [USER_INPUT, input],
            [PLANNER_RESPONSE, reply],
            [TOOL, reply],
            [ERROR_MESSAGE, error],
          ]),
          {
            failure: {
              class: "provider_error",
              message: "Requested entity was not found.",
              code: "NOT_FOUND",
              retryable: true,
            },
            resumeWith: "continue",
          },
        );
      }
      // A 404 before the model answered is an unknown or unentitled model.
      const unknownModel = yield* turn([
        [USER_INPUT, input],
        [ERROR_MESSAGE, STATUS_NOT_FOUND_ERROR],
      ]);
      assert.isFalse(unknownModel !== undefined && "resumeWith" in unknownModel);
      assert.equal(failureOf(unknownModel)?.retryable, false);
      for (const error of [
        "messages.0.content.1.thinking.signature: Field required",
        "messages.0.content.1: Invalid `signature` in `thinking` block",
      ]) {
        const outcome = yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, errorPayload(error)],
        ]);
        assert.equal(failureOf(outcome)?.code, "INVALID_THINKING_SIGNATURE");
      }
      const gateway = errorPayload(
        "Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []",
      );
      assert.deepInclude(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, gateway],
        ]),
        {
          class: "provider_error",
          message: "Bad Gateway: Failed to connect to backend API",
          retryable: true,
        },
      );
      assert.isUndefined(
        failureOf(
          yield* turn(
            [
              [USER_INPUT, input],
              [ERROR_MESSAGE, RATE_LIMIT_ERROR],
            ],
            undefined,
            { retired: true },
          ),
        )?.resetAt,
      );
      const absoluteQuota = errorPayload(
        "Error 429, Message: Quota exhausted., Status: RESOURCE_EXHAUSTED, Details: [reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-09T01:05:00Z quotaResetDelay:3600s]",
      );
      assert.equal(
        failureOf(
          yield* turn(
            [
              [USER_INPUT, input],
              [ERROR_MESSAGE, absoluteQuota],
            ],
            undefined,
            { retired: true },
          ),
        )?.resetAt,
        "2026-11-09T01:05:00.000Z",
      );
      // A completed tool keeps its usage, and the turn still fails.
      assert.equal(
        failureOf(
          yield* turn(
            [
              [USER_INPUT, input],
              [PLANNER_RESPONSE, reply],
              [TOOL, reply],
              [ERROR_MESSAGE, QUOTA_ERROR],
            ],
            {
              stopReason: "end_turn",
              usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
            },
          ),
        )?.class,
        "usage_limit",
      );
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      // The agent maps the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
      assert.deepEqual(yield* turn([], { stopReason: "refusal" }), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "QUOTA_EXHAUSTED",
        retryable: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads only this session's own unlinked log, and keeps a typed refusal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const own = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const peer = "0d9c2b4e-1111-4222-8333-944455556666";
      const append = (sessionId: string, type: number, payload: Uint8Array) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          database
            .prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)")
            .run(type, payload);
        } finally {
          database.close();
        }
      };

      // own.db links to a peer session; the peer's new error step is not this turn's.
      append(peer, USER_INPUT, Buffer.from("peer"));
      yield* fs.symlink(
        path.join(conversations, `${peer}.db`),
        path.join(conversations, `${own}.db`),
      );
      const linked = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      append(peer, ERROR_MESSAGE, QUOTA_ERROR);
      assert.isUndefined(yield* linked({ stopReason: "end_turn" }));
      assert.equal(failureOf(yield* linked({ stopReason: "refusal" }))?.class, "usage_limit");

      // An unreadable log gives no evidence, but the agent's typed refusal still fails the turn.
      yield* fs.remove(path.join(conversations, `${own}.db`));
      yield* fs.writeFileString(path.join(conversations, `${own}.db`), "not a database");
      const corrupt = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      assert.isUndefined(yield* corrupt({ stopReason: "end_turn" }));
      assert.deepEqual(yield* corrupt({ stopReason: "refusal" }), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "QUOTA_EXHAUSTED",
        retryable: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
