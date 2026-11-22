import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelBotMembers } from "../ChannelBotMembers.ts";
import { withWebhookService } from "../../scheduledTasks/ScheduledRunFixture.testkit.ts";
import { owner } from "./ChannelHarness.ts";
import { routineOwnerOf } from "../../scheduledTasks/scheduledBotRoutines.ts";
import * as Option from "effect/Option";

export const verifyBotTemplate = (
  members: ChannelBotMembers["Service"],
  sql: SqlClient.SqlClient,
) =>
  withWebhookService(
    ({ service }) =>
      Effect.gen(function* () {
        const input = {
          clientRequestId: "template-1",
          templateId: "pr-reviewer",
          name: "PR reviewer",
          avatar: null,
          purpose: "",
          defaultModelSelection: null,
        } as const;
        const denied = yield* members.create(input, owner).pipe(Effect.flip);
        assert.strictEqual(denied.reason, "forbidden");
        const context = {
          service,
          capture: Effect.succeed({
            memoryGrantCeiling: "none" as const,
            owner: {
              principalId: owner.principalId,
              grantedScopes: owner.grantedScopes,
              sessionId: "template-owner-session",
            },
          }),
        };
        yield* sql`CREATE TEMP TRIGGER fail_template BEFORE INSERT ON scheduled_tasks
        BEGIN SELECT RAISE(ABORT, 'fixture: scheduling unavailable'); END`;
        const bot = yield* members.create(input, owner, context);
        assert.match(bot.instructions ?? "", /pull request/i);
        assert.isTrue(bot.templateAutomationPending);
        assert.deepEqual((yield* service.list()).tasks, []);
        const revoked = yield* members
          .create(input, owner, {
            service,
            capture: Effect.succeed({ memoryGrantCeiling: "none" }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(revoked.reason, "forbidden");
        yield* sql`DROP TRIGGER fail_template`;
        const retry = yield* members.create(input, owner, context);
        assert.strictEqual(retry.botId, bot.botId);
        assert.isUndefined(retry.templateAutomationPending);
        assert.strictEqual((yield* members.create(input, owner, context)).botId, bot.botId);
        const { tasks } = yield* service.list();
        assert.lengthOf(tasks, 1);
        assert.strictEqual(tasks[0]?.threadId, bot.sessionThreadId);
        assert.strictEqual(tasks[0]?.schedule.type, "webhook");
        assert.strictEqual(tasks[0]?.routineMode, "work");
        assert.isFalse(tasks[0]?.enabled);
        const [row] = yield* sql<{ owner_json: string }>`SELECT owner_json FROM scheduled_tasks`;
        assert.strictEqual(
          Option.getOrUndefined(routineOwnerOf(row?.owner_json))?.principalId,
          owner.principalId,
        );
      }),
    { sql },
  );
